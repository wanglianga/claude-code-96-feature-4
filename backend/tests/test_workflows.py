import pytest
from sqlalchemy import select

from app.database import SessionLocal
from app.models import (
    Escalation, Event, FollowUpTask, ManualQueueItem, Notification, Order,
    Patient, PharmacyReview, Referral, Report,
)
from app.services import escalation as esc_svc
from app.services import notifications as notify_svc
from app.services import pharmacy as ph_svc
from app.services import queue as queue_svc
from app.services import reports as report_svc
from app.services import tasks as task_svc
from app.services.discharge import discharge_and_plan
from app import serializers as ser
from conftest import make_patient, staff
from datetime import datetime, timedelta


# ---------- 1. 分级随访 ----------

def test_grading_l3_for_cardiac(fresh_db):
    db = fresh_db
    p = make_patient(db, surgery_type="心脏搭桥（CABG）")
    tasks = db.scalars(select(FollowUpTask).where(
        FollowUpTask.patient_id == p.id, FollowUpTask.kind == "auto")).all()
    assert all(t.level == "L3" for t in tasks)
    assert len(tasks) == 5  # 24/48/72h/7d/14d
    assert tasks[0].status == "scheduled"


def test_grading_l1_default(fresh_db):
    db = fresh_db
    p = make_patient(db)
    tasks = db.scalars(select(FollowUpTask).where(
        FollowUpTask.patient_id == p.id, FollowUpTask.kind == "auto")).all()
    assert all(t.level == "L2" for t in tasks)  # 腹腔镜命中 L2 规则
    assert len(tasks) == 3


def test_discharge_plan_idempotent(fresh_db):
    db = fresh_db
    p = make_patient(db)
    before = db.query(FollowUpTask).count()
    discharge_and_plan(db, p, datetime.utcnow() - timedelta(days=1))
    db.commit()
    assert db.query(FollowUpTask).count() == before


# ---------- 2. 高风险冻结 + 升级 ----------

def test_high_risk_freezes_tasks_and_opens_one_escalation(fresh_db):
    db = fresh_db
    p = make_patient(db)
    auto = db.scalars(select(FollowUpTask).where(
        FollowUpTask.patient_id == p.id, FollowUpTask.kind == "auto")).all()
    res = report_svc.submit_report(db, p, {
        "symptoms": ["胸痛"], "symptom_text": "压榨样胸痛伴出汗",
        "temperature": 37.0, "systolic": 120, "diastolic": 80,
        "idempotency_key": "r1"})
    assert res["escalation"] is not None
    esc = res["escalation"]
    assert esc.status == "open"
    db.expire_all()
    for t in db.scalars(select(FollowUpTask).where(FollowUpTask.patient_id == p.id)):
        assert t.status == "frozen"
        assert t.escalation_id == esc.id
    # 升级单开启事件 + 每个任务冻结事件均入时间线
    types_ = {ev.event_type for ev in db.scalars(
        select(Event).where(Event.patient_id == p.id))}
    assert "escalation.opened" in types_
    assert "task.frozen" in types_


def test_normal_report_does_not_escalate(fresh_db):
    db = fresh_db
    p = make_patient(db)
    res = report_svc.submit_report(db, p, {
        "symptoms": ["轻微乏力"], "temperature": 36.8,
        "idempotency_key": "ok1"})
    assert res["escalation"] is None
    assert db.query(Escalation).count() == 0
    # 普通任务不被冻结
    assert all(t.status == "scheduled" for t in db.scalars(
        select(FollowUpTask).where(FollowUpTask.patient_id == p.id)))


def test_vitals_thresholds(fresh_db):
    db = fresh_db
    p = make_patient(db)
    res = report_svc.submit_report(db, p, {
        "symptoms": [], "temperature": 39.4, "systolic": 190, "diastolic": 115,
        "idempotency_key": "v1"})
    codes = {h["code"] for h in res["report"].risk_hits}
    assert {"FEVER_HIGH", "BP_EXTREME"} <= codes
    assert res["escalation"] is not None


# ---------- 3. 幂等 + 跨入口去重 ----------

def test_idempotency_key_replay(fresh_db):
    db = fresh_db
    p = make_patient(db)
    a = report_svc.submit_report(db, p, {"symptoms": ["头痛"],
                                         "idempotency_key": "K1"})
    b = report_svc.submit_report(db, p, {"symptoms": ["头痛"],
                                         "idempotency_key": "K1"})
    assert a["report"].id == b["report"].id
    assert b["created"] is False
    assert db.query(Report).filter(Report.idempotency_key == "K1").count() == 1


def test_cross_channel_duplicate_merged_no_double_escalation(fresh_db):
    db = fresh_db
    p = make_patient(db)
    common = {"symptoms": ["伤口出血"], "symptom_text": "敷料有血",
              "temperature": 37.1, "systolic": 120, "diastolic": 80}
    r1 = report_svc.submit_report(db, p, {**common, "channel": "portal",
                                          "idempotency_key": "a"})
    r2 = report_svc.submit_report(db, p, {**common, "channel": "mini_app",
                                          "idempotency_key": "b"})
    assert r1["created"] and r2["duplicate"] is True
    assert r2["report"].status == "merged"
    assert r2["report"].duplicate_of_id == r1["report"].id
    # 只有一次升级
    assert db.query(Escalation).count() == 1
    merge_event = db.scalar(select(Event).where(Event.event_type == "report.merged"))
    assert merge_event is not None


# ---------- 4. 护士三动作 + 转诊幂等 ----------

def _open_escalation(db, p, key="e1"):
    return report_svc.submit_report(db, p, {
        "symptoms": ["胸痛"], "temperature": 37.0,
        "idempotency_key": key})["escalation"]


def test_nurse_actions_workflow(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p)
    n = staff(db, "n1")
    esc_svc.nurse_screen(db, esc.id, n, "phone_callback",
                         "已联系，症状缓解", extra={"reached": True, "outcome": "缓解"})
    db.expire_all()
    assert db.get(Escalation, esc.id).status == "phone_followup"


def test_ed_advice(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p)
    esc_svc.nurse_screen(db, esc.id, staff(db, "n1"), "ed_advice", "请立即急诊")
    assert db.get(Escalation, esc.id).status == "ed_advised"


def test_referral_request_unique_per_escalation(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p)
    r1 = esc_svc.nurse_screen(db, esc.id, staff(db, "n1"), "referral_request",
                              "疑似心梗", extra={"target": "心内科"})
    r2 = esc_svc.nurse_screen(db, esc.id, staff(db, "n2"), "referral_request",
                              "重复申请", extra={"target": "心内科"})
    assert r1["referral_created"] is True
    assert r2["referral_created"] is False
    assert r1["referral"].id == r2["referral"].id
    assert db.query(Referral).filter(Referral.escalation_id == esc.id).count() == 1


def test_concurrent_referral_insert_only_one(fresh_db):
    """两个独立事务同时建转诊：唯一守卫 active_guard 拒绝重复。"""
    db = fresh_db
    from app.database import SessionLocal
    from app.models import Referral
    from sqlalchemy.exc import IntegrityError
    p = make_patient(db)
    esc = _open_escalation(db, p)
    n = staff(db, "n1")
    now = datetime.utcnow()
    with SessionLocal() as s1:
        s1.add(Referral(escalation_id=esc.id, patient_id=p.id, target="心内科",
                        requested_by_id=n.id, request_event_time=now,
                        active_guard=f"esc:{esc.id}"))
        s1.commit()
    with pytest.raises(IntegrityError):
        with SessionLocal() as s2:
            s2.add(Referral(escalation_id=esc.id, patient_id=p.id, target="心内cc",
                            requested_by_id=n.id, request_event_time=now,
                            active_guard=f"esc:{esc.id}"))
            s2.flush()
    assert db.query(Referral).filter(Referral.escalation_id == esc.id).count() == 1


def test_concurrent_escalation_guard(fresh_db):
    db = fresh_db
    from sqlalchemy.exc import IntegrityError
    p = make_patient(db)
    now = datetime.utcnow()
    e1 = Escalation(patient_id=p.id, status="open", opened_at=now,
                    sla_due_at=now + timedelta(hours=2), active_guard=f"patient:{p.id}")
    db.add(e1); db.flush()
    e2 = Escalation(patient_id=p.id, status="open", opened_at=now,
                    sla_due_at=now + timedelta(hours=2), active_guard=f"patient:{p.id}")
    db.add(e2)
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_worsening_while_referral_pending_attaches_not_duplicate(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p, "w1")
    esc_svc.nurse_screen(db, esc.id, staff(db, "n1"), "referral_request",
                         "需专科", extra={"target": "心内科"})
    # 转诊尚未确认，患者再次上报恶化
    res = report_svc.submit_report(db, p, {
        "symptoms": ["呼吸困难", "胸痛"], "temperature": 37.5,
        "idempotency_key": "w2"})
    assert res["escalation"].id == esc.id
    assert db.query(Escalation).count() == 1
    assert db.query(Referral).count() == 1
    w = db.scalar(select(Event).where(Event.event_type == "escalation.worsening"))
    assert w is not None
    assert "转诊尚未确认" in w.summary


# ---------- 5. 医生补录 / 撤回 / 医嘱冲突替代 ----------

def test_backdated_doctor_order_timeline_order(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p, "b1")
    n = staff(db, "n1"); d = staff(db, "d1")
    base = datetime.utcnow() - timedelta(minutes=30)
    nurse_time = base + timedelta(hours=1, minutes=30)
    esc_svc.nurse_screen(db, esc.id, n, "phone_callback", "护士先记录",
                         event_time=nurse_time,
                         extra={"reached": True, "outcome": ""})
    # 医生补录：业务时间早于护士记录
    doctor_time = base
    o = esc_svc.add_doctor_order(db, p.id, d, {
        "order_type": "other", "content": "补录：出院带药剂量更正",
        "escalation_id": esc.id, "event_time": doctor_time})
    events = db.scalars(select(Event).where(Event.patient_id == p.id)
                        .order_by(Event.event_time)).all()
    order_idx = next(i for i, e in enumerate(events) if e.event_type == "order.added")
    nurse_idx = next(i for i, e in enumerate(events) if e.event_type == "nurse.phone_callback")
    assert order_idx < nurse_idx  # 时间线按业务时间，补录在前
    # recorded_at 仍是真实落库时间（晚），且原始记录不改写
    assert o.recorded_at > o.event_time
    order_ev = events[order_idx]
    assert order_ev.data["backdated"] is True


def test_withdraw_order_preserves_original(fresh_db):
    db = fresh_db
    p = make_patient(db)
    d = staff(db, "d1")
    o = esc_svc.add_doctor_order(db, p.id, d, {
        "order_type": "medication", "content": "阿司匹林 100mg 每日一次"})
    original_content = o.content
    esc_svc.withdraw_order(db, o.id, d, "剂量开错，应为 50mg")
    db.expire_all()
    o2 = db.get(Order, o.id)
    assert o2.status == "withdrawn"
    assert o2.content == original_content  # 原文保留
    assert o2.withdraw_reason == "剂量开错，应为 50mg"
    types_ = [ev.event_type for ev in db.scalars(select(Event).where(
        Event.patient_id == p.id, Event.aggregate == "order"))]
    assert types_ == ["order.added", "order.withdrawn"]
    # 不能重复撤回
    with pytest.raises(ValueError):
        esc_svc.withdraw_order(db, o.id, d, "再撤一次")


def test_new_order_supersedes_conflicting_tasks(fresh_db):
    db = fresh_db
    p = make_patient(db)
    before = db.scalars(select(FollowUpTask).where(
        FollowUpTask.patient_id == p.id, FollowUpTask.status == "scheduled")).all()
    assert len(before) >= 2
    d = staff(db, "d1")
    esc_svc.add_doctor_order(db, p.id, d, {
        "order_type": "follow_adjust",
        "content": "停止常规电话随访，改为术后第10天门诊复查",
        "task_title": "术后第10天门诊复查随访"})
    db.expire_all()
    old = db.scalars(select(FollowUpTask).where(
        FollowUpTask.patient_id == p.id, FollowUpTask.kind == "auto")).all()
    assert all(t.status == "cancelled" for t in old)
    assert all(t.superseded_by_order_id is not None for t in old)
    new_t = db.scalar(select(FollowUpTask).where(FollowUpTask.kind == "manual"))
    assert new_t is not None and new_t.status == "scheduled"
    # 旧任务的取消事件 + 替代关系事件都可追溯
    supersede_events = db.scalars(select(Event).where(
        Event.event_type == "task.supersedes")).all()
    assert len(supersede_events) == len(old)


# ---------- 6. 药师隔离 ----------

def test_pharmacist_cannot_touch_non_medication(fresh_db):
    db = fresh_db
    p = make_patient(db)
    d = staff(db, "d1"); ph = staff(db, "p1")
    o = esc_svc.add_doctor_order(db, p.id, d, {
        "order_type": "exam", "content": "胸部CT 复查"})
    with pytest.raises(PermissionError):
        ph_svc.review_medication(db, p.id, ph, {"order_id": o.id, "advice": "建议"})


def test_pharmacist_review_does_not_change_order_conclusion(fresh_db):
    db = fresh_db
    p = make_patient(db)
    d = staff(db, "d1"); ph = staff(db, "p1")
    o = esc_svc.add_doctor_order(db, p.id, d, {
        "order_type": "medication", "content": "华法林 3mg 每日一次"})
    rv = ph_svc.review_medication(db, p.id, ph, {
        "order_id": o.id, "interaction_found": True,
        "interaction_detail": "华法林 × 阿司匹林：出血风险",
        "advice": "建议医生评估是否联用"})
    db.refresh(o)
    assert o.status == "active"          # 诊疗结论未被药师改动
    assert o.content.startswith("华法林")
    assert o.pharmacy_status == "interaction_flag"
    assert isinstance(rv, PharmacyReview)


def test_pharmacist_sees_masked_fields(fresh_db):
    db = fresh_db
    p = make_patient(db, name="欧阳修远", phone="13812345678")
    ph = staff(db, "p1")
    view = ser.patient_full(p, ph)
    assert view["name"] == "欧***"
    assert view["phone"] == "138****5678"
    assert view["allergy"] == "青霉素"  # 过敏史对药师可见（用药安全）
    n = staff(db, "n1")
    assert ser.patient_full(p, n)["phone"] == "13812345678"


def test_pharmacist_report_fields_hidden(fresh_db):
    db = fresh_db
    p = make_patient(db)
    res = report_svc.submit_report(db, p, {
        "symptoms": ["胸痛"], "symptom_text": "剧痛", "temperature": 38.0,
        "systolic": 120, "diastolic": 80, "idempotency_key": "ph1"})
    r = res["report"]
    ph = staff(db, "p1")
    out = ser.report_out(r, ph, p)
    assert out["symptoms"] == []
    assert out["symptom_text"] == ser.HIDDEN
    assert out["temperature"] is None
    # 护士可见
    n = staff(db, "n1")
    assert ser.report_out(r, n, p)["symptoms"] == ["胸痛"]


# ---------- 7. 人工队列：拒联系 / 授权过期 / 图片不可读 ----------

def test_contact_refused_and_consent_expired_queue(fresh_db):
    db = fresh_db
    p = make_patient(db, contact_refused=True,
                     consent_until=datetime.utcnow() - timedelta(days=1))
    report_svc.submit_report(db, p, {"symptoms": ["乏力"],
                                     "contact_ok": False, "idempotency_key": "q1"})
    reasons = {q.reason_type for q in db.scalars(select(ManualQueueItem)).all()}
    assert {"contact_refused", "consent_expired"} <= reasons


def test_unreadable_image_queued(fresh_db):
    db = fresh_db
    from app.models import ReportImage
    p = make_patient(db)
    img = ReportImage(filename="bad.jpg", content_type="image/jpeg", size=20,
                      sha256="x", status="unreadable",
                      unreadable_reason="JPEG 数据不完整")
    db.add(img); db.commit()
    report_svc.submit_report(db, p, {"symptoms": ["伤口红肿"],
                                     "image_ids": [img.id], "idempotency_key": "img1"})
    item = db.scalar(select(ManualQueueItem).where(
        ManualQueueItem.reason_type == "image_unreadable"))
    assert item is not None
    assert "bad.jpg" in item.detail


def test_queue_dedup_and_claim_resolve(fresh_db):
    db = fresh_db
    p = make_patient(db, contact_refused=True)
    report_svc.submit_report(db, p, {"symptoms": ["x"], "contact_ok": False,
                                     "idempotency_key": "d1"})
    report_svc.submit_report(db, p, {"symptoms": ["y"], "contact_ok": False,
                                     "idempotency_key": "d2"})
    opens = db.scalars(select(ManualQueueItem).where(
        ManualQueueItem.reason_type == "contact_refused")).all()
    assert len(opens) == 1  # 同原因去重
    n = staff(db, "n1")
    queue_svc.claim(db, opens[0].id, n.id)
    queue_svc.resolve(db, opens[0].id, n.id, "王护士", "已短信沟通")
    db.commit()
    assert db.get(ManualQueueItem, opens[0].id).status == "resolved"


# ---------- 8. 通知失败重试 + 死信转人工；SLA 持续提醒 ----------

def test_notification_retry_then_dead_and_queue(fresh_db):
    db = fresh_db
    p = make_patient(db)
    bad = staff(db, "n3")
    notify_svc.enqueue(db, ntype="t", title="测试失败通知", body="x",
                       target_staff_id=bad.id, patient_id=p.id,
                       max_attempts=3, commit=True)
    for _ in range(3):
        notify_svc.deliver_pending(db)
        # 让退避到期
        for n in db.scalars(select(Notification)).all():
            n.next_attempt_at = datetime.utcnow() - timedelta(seconds=1)
        db.commit()
    assert db.scalar(select(Notification).where(Notification.status == "dead"))
    n_dead = task_svc.sweep_dead_notifications(db)
    assert n_dead == 1
    assert db.scalar(select(ManualQueueItem).where(
        ManualQueueItem.reason_type == "notify_dead")) is not None


def test_sla_overdue_reminds_repeatedly_then_queue(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p, "s1")
    # 把 SLA 截止时间推到过去
    esc.sla_due_at = datetime.utcnow() - timedelta(minutes=10)
    db.commit()
    r1 = task_svc.sweep_sla(db)
    assert r1["reminded_escalations"] == 1 and r1["queued"] == 0
    r2 = task_svc.sweep_sla(db)
    assert r2["queued"] == 1  # 第 2 次仍未闭环 → 人工队列
    # 每次提醒都产生通知与提醒事件（持续提醒）
    reminders = db.scalars(select(Event).where(
        Event.event_type == "escalation.sla_reminder")).all()
    assert len(reminders) == 2
    assert db.get(Escalation, esc.id).reminder_count == 2


def test_notification_failure_does_not_rollback_business(fresh_db):
    db = fresh_db
    p = make_patient(db)
    # 高风险上报给所有护士发通知，其中 n3 通道坏；业务仍成功
    res = report_svc.submit_report(db, p, {"symptoms": ["胸痛"],
                                           "idempotency_key": "nf1"})
    assert res["escalation"] is not None
    assert db.query(Escalation).count() == 1


# ---------- 9. 关闭升级单与冻结任务处置 ----------

def test_close_requires_basis_and_blocks_pending_referral(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p, "c1")
    n = staff(db, "n1")
    esc_svc.nurse_screen(db, esc.id, n, "referral_request", "x",
                         extra={"target": "心内科"})
    with pytest.raises(ValueError):
        esc_svc.close_escalation(db, esc.id, n, "关闭")
    # 医生确认转诊后可关闭
    d = staff(db, "d1")
    ref = db.scalar(select(Referral))
    esc_svc.decide_referral(db, ref.id, d, "confirm", "已联系心内科")
    closed = esc_svc.close_escalation(db, esc.id, n, "患者已转诊收治，闭环")
    assert closed.status == "closed"
    assert closed.closure_basis
    assert closed.active_guard is None
    # 冻结的未来任务恢复
    statuses = {t.status for t in db.scalars(select(FollowUpTask).where(
        FollowUpTask.patient_id == p.id))}
    assert "scheduled" in statuses


def test_close_cancels_due_frozen_tasks(fresh_db):
    db = fresh_db
    now = datetime.utcnow()
    p = Patient(
        code="PX", name="过期任务患者", gender="女", birth_date="1970-01-01",
        phone="13700000000", id_card_tail="0000", department="x",
        surgery_type="心脏搭桥", surgery_date="2026-09-20",
        discharge_date="2026-09-26", discharge_orders="抗凝", allergy="无",
        consent_until=now + timedelta(days=10))
    db.add(p); db.commit()
    discharge_and_plan(db, p, now - timedelta(days=10))  # 24h 任务已过期
    db.commit()
    esc = _open_escalation(db, p, "c2")
    n = staff(db, "n1")
    esc_svc.close_escalation(db, esc.id, n, "已处置，自动处置冻结任务")
    cancelled = db.scalars(select(FollowUpTask).where(
        FollowUpTask.patient_id == p.id, FollowUpTask.status == "cancelled")).all()
    assert cancelled  # 到期的旧任务被取消且注明替代来源


# ---------- 10. 时间线可追溯 + 脱敏过滤 ----------

def test_timeline_complete_and_append_only(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p, "t1")
    n = staff(db, "n1"); d = staff(db, "d1"); ph = staff(db, "p1")
    esc_svc.nurse_screen(db, esc.id, n, "referral_request", "胸痛待排查",
                         extra={"target": "心内科"})
    ref = db.scalar(select(Referral))
    esc_svc.decide_referral(db, ref.id, d, "confirm", "收住")
    esc_svc.add_doctor_order(db, p.id, d, {
        "order_type": "medication", "content": "氯吡格雷 75mg 每日一次",
        "escalation_id": esc.id})
    o = db.scalar(select(Order).where(Order.patient_id == p.id))
    ph_svc.review_medication(db, p.id, ph, {"order_id": o.id,
                                            "advice": "注意与奥美拉唑间隔"})
    esc_svc.close_escalation(db, esc.id, n, "转诊收治，完成闭环")
    types_ = [ev.event_type for ev in db.scalars(select(Event)
             .where(Event.patient_id == p.id).order_by(Event.id))]
    for required in ["report.submitted", "escalation.opened", "task.frozen",
                     "nurse.referral_request", "referral.requested",
                     "referral.confirmed", "order.added", "pharmacy.reviewed",
                     "escalation.closed", "task.resumed"]:
        assert required in types_, required
    # 事件表无任何 UPDATE/DELETE 接口被调用：撤回只是新增
    assert db.query(Event).count() == len(types_)


def test_pharmacist_timeline_hides_triage_details(fresh_db):
    db = fresh_db
    p = make_patient(db)
    esc = _open_escalation(db, p, "h1")
    esc_svc.nurse_screen(db, esc.id, staff(db, "n1"), "phone_callback",
                         "患者说家里私事，拒绝谈病情",
                         extra={"reached": False})
    ph = staff(db, "p1")
    events = db.scalars(select(Event).where(Event.patient_id == p.id)).all()
    visible = [ser.event_out(e, ph) for e in events]
    visible = [v for v in visible if v]
    assert all("nurse.phone_callback" != v["event_type"] for v in visible)
    n = staff(db, "n1")
    assert any(ser.event_out(e, n) and ser.event_out(e, n)["event_type"]
               == "nurse.phone_callback" for e in events)


# ---------- 11. 真实跨线程并发：高风险上报只允许一个升级单 ----------

def test_parallel_high_risk_reports_single_escalation(fresh_db):
    import threading
    db = fresh_db
    p = make_patient(db)
    pid = p.id
    db.commit()

    barrier = threading.Barrier(2)
    results: list = []
    errors: list = []

    def worker(key):
        s = SessionLocal()
        try:
            pat = s.get(Patient, pid)
            barrier.wait(timeout=10)
            r = report_svc.submit_report(s, pat, {
                "symptoms": ["胸痛", "呼吸困难"], "temperature": 37.2,
                "idempotency_key": key})
            results.append(r["escalation"].id if r["escalation"] else None)
        except Exception as exc:  # noqa
            errors.append(repr(exc))
        finally:
            s.close()

    t1 = threading.Thread(target=worker, args=("par-1",))
    t2 = threading.Thread(target=worker, args=("par-2",))
    t1.start(); t2.start(); t1.join(15); t2.join(15)

    assert not errors, errors
    escs = db.query(Escalation).all()
    assert len(escs) == 1
    # 两个请求都挂接到同一个升级单
    assert results == [escs[0].id, escs[0].id]
    # 两条上报均存在（幂等键不同，不是重复提交），第二条不再触发冻结
    assert db.query(Report).filter(Report.patient_id == pid).count() == 2
    worsening = db.scalar(select(Event).where(
        Event.event_type == "escalation.worsening"))
    assert worsening is not None
