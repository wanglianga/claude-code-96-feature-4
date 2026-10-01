"""升级单处置工作流。

角色边界：
- 护士：初筛 → 电话回访 / 急诊建议 / 转诊申请；可关闭升级单。
- 医生：补充/撤回医嘱、确认或驳回转诊、关闭升级单；不能替护士做初筛动作。
- 药师：仅用药相互作用与用药建议（见 pharmacy 服务），不能改诊疗结论。
时间语义：所有动作接受 event_time（可补录），时间线按 event_time 排序，
补录早于他人记录不影响既有记录，只在时间线上呈现真实先后。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import (
    Callback,
    Escalation,
    FollowUpTask,
    Order,
    Referral,
    Staff,
    TriageAction,
)
from ..events import record_event
from . import notifications as notify
from . import queue as manual_queue

ACTIVE_ESC_STATUSES = ("open", "phone_followup", "ed_advised", "referral_requested",
                      "referral_confirmed")


def get_escalation(db: Session, esc_id: int) -> Escalation:
    esc = db.get(Escalation, esc_id)
    if esc is None:
        raise ValueError("升级单不存在")
    if esc.status == "closed":
        raise ValueError("升级单已关闭")
    return esc


# ---------------- 护士初筛 ----------------

def nurse_screen(db: Session, esc_id: int, nurse: Staff, action: str,
                 note: str = "", event_time: datetime | None = None,
                 extra: dict | None = None) -> dict:
    extra = extra or {}
    event_time = event_time or datetime.utcnow()
    esc = get_escalation(db, esc_id)
    result: dict = {"escalation": esc}

    ta = TriageAction(
        escalation_id=esc.id, nurse_id=nurse.id, action=action, note=note,
        event_time=event_time,
    )
    db.add(ta)

    if action == "phone_callback":
        esc.status = "phone_followup"
        reached = bool(extra.get("reached"))
        outcome = extra.get("outcome", "")
        cb = Callback(
            escalation_id=esc.id, nurse_id=nurse.id, reached=reached,
            outcome=outcome, note=note, event_time=event_time,
        )
        db.add(cb)
        db.flush()
        summary = f"护士 {nurse.name} 电话回访：{'已联系' if reached else '未联系到'} {outcome}"
        if not reached and ("拒接" in note or "拒绝" in note or extra.get("refused")):
            manual_queue.enqueue_manual(
                db, patient_id=esc.patient_id, reason_type="contact_refused",
                detail=f"升级单 #{esc.id} 电话回访被拒/拒接：{note}",
                escalation_id=esc.id,
            )
        result["callback"] = cb
    elif action == "ed_advice":
        esc.status = "ed_advised"
        summary = f"护士 {nurse.name} 给出急诊建议：{note}"
        notify.enqueue(
            db, ntype="ed_advice", title=f"急诊建议已告知患者（升级单 #{esc.id}）",
            body=note, target_staff_id=nurse.id, channel="im",
            patient_id=esc.patient_id,
        )
    elif action == "referral_request":
        target = (extra.get("target") or "").strip()
        if not target:
            raise ValueError("转诊必须指定目标科室/医院")
        referral, created = _request_referral(db, esc, nurse, target, note, event_time)
        result["referral"] = referral
        result["referral_created"] = created
        summary = (
            f"护士 {nurse.name} 提交转诊申请 → {target}"
            if created else f"转诊已存在（并发重复申请已拦截），沿用转诊单 #{referral.id}"
        )
    elif action == "note":
        summary = f"护士 {nurse.name} 初筛备注：{note}"
    else:
        raise ValueError(f"不支持的初筛动作：{action}")

    db.flush()
    record_event(
        db, patient_id=esc.patient_id, aggregate="escalation", aggregate_id=esc.id,
        event_type=f"nurse.{action}", event_time=event_time,
        actor_type="staff", actor_id=nurse.id, actor_name=nurse.name,
        summary=summary, data={"note": note, **{k: v for k, v in extra.items() if k != "target"}},
    )
    db.commit()
    return result


def _request_referral(db: Session, esc: Escalation, nurse: Staff, target: str,
                      reason: str, event_time: datetime) -> tuple[Referral, bool]:
    # 幂等校验：已有进行中的转诊则直接沿用
    existing = db.scalar(
        select(Referral).where(
            Referral.escalation_id == esc.id,
            Referral.status.in_(["requested", "confirmed"]),
        )
    )
    if existing:
        return existing, False

    ref = Referral(
        escalation_id=esc.id, patient_id=esc.patient_id, target=target, reason=reason,
        requested_by_id=nurse.id, request_event_time=event_time,
        active_guard=f"esc:{esc.id}",
    )
    # SAVEPOINT：双击/两个护士并发时，唯一守卫只回滚保存点，
    # 不影响同一事务里已写入的初筛动作。
    try:
        with db.begin_nested():
            db.add(ref)
            db.flush()
    except IntegrityError:
        existing = db.scalar(
            select(Referral).where(
                Referral.escalation_id == esc.id,
                Referral.status.in_(["requested", "confirmed"]),
            )
        )
        if existing is not None:
            return existing, False
        raise

    esc.status = "referral_requested"
    doctors = db.scalars(
        select(Staff).where(Staff.role == "doctor", Staff.active.is_(True))
    ).all()
    for d in doctors:
        notify.enqueue(
            db, ntype="referral", title=f"转诊申请待确认：{esc.patient_id} → {target}",
            body=reason or f"升级单 #{esc.id}", target_staff_id=d.id, channel="im",
            patient_id=esc.patient_id,
        )
    record_event(
        db, patient_id=esc.patient_id, aggregate="referral", aggregate_id=ref.id,
        event_type="referral.requested", event_time=event_time,
        actor_type="staff", actor_id=nurse.id, actor_name=nurse.name,
        summary=f"转诊申请 #{ref.id}：→ {target}（待确认）",
        data={"target": target, "reason": reason},
    )
    return ref, True


# ---------------- 转诊确认 / 驳回（医生或管理员） ----------------

def decide_referral(db: Session, referral_id: int, staff: Staff, decision: str,
                    note: str = "", event_time: datetime | None = None) -> Referral:
    event_time = event_time or datetime.utcnow()
    ref = db.get(Referral, referral_id)
    if ref is None:
        raise ValueError("转诊单不存在")
    if ref.status not in ("requested",):
        raise ValueError(f"转诊单当前状态 {ref.status}，不可再确认/驳回")

    esc = db.get(Escalation, ref.escalation_id)
    if decision == "confirm":
        ref.status = "confirmed"
        ref.confirmed_at = event_time
        ref.confirmation_note = note
        esc.status = "referral_confirmed"
        summary = f"{staff.role_label if hasattr(staff,'role_label') else ''}{staff.name} 确认转诊 → {ref.target}：{note}"
        etype = "referral.confirmed"
    elif decision == "reject":
        ref.status = "rejected"
        ref.confirmation_note = note
        if esc and esc.status == "referral_requested":
            esc.status = "open"  # 退回，护士可重新处置
        summary = f"{staff.name} 驳回转诊 → {ref.target}：{note}"
        etype = "referral.rejected"
    else:
        raise ValueError("decision 必须是 confirm / reject")

    ref.active_guard = None  # 终态/已确认均释放守卫，允许后续必要时重新申请
    db.flush()
    record_event(
        db, patient_id=ref.patient_id, aggregate="referral", aggregate_id=ref.id,
        event_type=etype, event_time=event_time,
        actor_type="staff", actor_id=staff.id, actor_name=staff.name,
        summary=summary, data={"note": note},
    )
    notify.enqueue(
        db, ntype="referral_result",
        title=f"转诊已{'确认' if decision == 'confirm' else '驳回'}（#{ref.id}）",
        body=note, target_staff_id=ref.requested_by_id, channel="im",
        patient_id=ref.patient_id,
    )
    db.commit()
    return ref


# ---------------- 医生医嘱 ----------------

def add_doctor_order(db: Session, patient_id: int, doctor: Staff, payload: dict) -> Order:
    """补充医嘱。event_time 可早于护士记录（补录）；原始内容只追加不修改。

    order_type=follow_adjust 时，处理“新医嘱与既有随访计划冲突”：
    未完成的旧自动任务显式取消并标注被本医嘱替代，再按医嘱生成新任务。
    """
    event_time = payload.get("event_time") or datetime.utcnow()
    if isinstance(event_time, str):
        event_time = datetime.fromisoformat(event_time)
    esc_id = payload.get("escalation_id")
    order = Order(
        patient_id=patient_id,
        escalation_id=esc_id,
        doctor_id=doctor.id,
        order_type=payload["order_type"],
        content=payload["content"],
        event_time=event_time,
        pharmacy_status="pending" if payload["order_type"] == "medication" else "not_required",
    )
    db.add(order)
    db.flush()
    record_event(
        db, patient_id=patient_id, aggregate="order", aggregate_id=order.id,
        event_type="order.added", event_time=event_time,
        actor_type="staff", actor_id=doctor.id, actor_name=doctor.name,
        summary=f"医生 {doctor.name} 下达医嘱（{order_type_label(order.order_type)}）：{order.content}",
        data={"order_type": order.order_type, "backdated": event_time < datetime.utcnow(),
              "escalation_id": esc_id},
    )

    if order.order_type == "follow_adjust":
        _supersede_conflicting_tasks(db, patient_id, order, doctor, payload, event_time)

    if order.pharmacy_status == "pending":
        for ph in db.scalars(select(Staff).where(
            Staff.role == "pharmacist", Staff.active.is_(True)
        )).all():
            notify.enqueue(
                db, ntype="pharmacy", title="有新用药医嘱待审方",
                body=f"{order.content}", target_staff_id=ph.id, channel="im",
                patient_id=patient_id,
            )

    db.commit()
    return order


def _supersede_conflicting_tasks(db: Session, patient_id: int, order: Order,
                                 doctor: Staff, payload: dict, event_time: datetime):
    tasks = db.scalars(
        select(FollowUpTask).where(
            FollowUpTask.patient_id == patient_id,
            FollowUpTask.kind == "auto",
            FollowUpTask.status.in_(["scheduled", "in_progress", "frozen"]),
        )
    ).all()
    old_ids = []
    for t in tasks:
        t.status = "cancelled"
        t.cancel_reason = f"与医生新医嘱（医嘱 #{order.id}）冲突，医嘱优先"
        t.superseded_by_order_id = order.id
        t.closed_at = event_time
        old_ids.append(t.id)
        record_event(
            db, patient_id=patient_id, aggregate="task", aggregate_id=t.id,
            event_type="task.cancelled", event_time=event_time,
            actor_type="staff", actor_id=doctor.id, actor_name=doctor.name,
            summary=(f"旧随访任务“{t.title}”因新医嘱冲突取消，"
                     f"替代关系：医嘱 #{order.id} → 任务 #{t.id}"),
            data={"superseded_by_order_id": order.id, "reason": t.cancel_reason},
        )

    # 以医嘱生成替代任务（manual，归护士执行）
    new_task = FollowUpTask(
        patient_id=patient_id,
        level="MANUAL",
        kind="manual",
        status="scheduled",
        title=f"按医嘱执行：{(payload.get('task_title') or order.content)[:60]}",
        reason=f"医生医嘱 #{order.id} 替代原 {len(old_ids)} 个随访任务",
        due_at=payload.get("due_at") and datetime.fromisoformat(payload["due_at"]) or event_time,
        assignee_role="nurse",
        escalation_id=order.escalation_id,
    )
    db.add(new_task)
    db.flush()
    for old_id in old_ids:
        record_event(
            db, patient_id=patient_id, aggregate="task", aggregate_id=new_task.id,
            event_type="task.supersedes", event_time=event_time,
            actor_type="staff", actor_id=doctor.id, actor_name=doctor.name,
            summary=f"新任务 #{new_task.id} 替代旧任务 #{old_id}",
            data={"new_task_id": new_task.id, "old_task_id": old_id,
                  "order_id": order.id},
        )
    record_event(
        db, patient_id=patient_id, aggregate="task", aggregate_id=new_task.id,
        event_type="task.scheduled", event_time=new_task.due_at,
        actor_type="staff", actor_id=doctor.id, actor_name=doctor.name,
        summary=f"按医嘱生成替代任务 #{new_task.id}：{new_task.title}",
        data={"superseded": old_ids, "order_id": order.id},
    )


def withdraw_order(db: Session, order_id: int, doctor: Staff, reason: str,
                   event_time: datetime | None = None) -> Order:
    """撤回错误医嘱：只追加撤回事件，原始医嘱内容永久保留可审计。"""
    event_time = event_time or datetime.utcnow()
    if isinstance(event_time, str):
        event_time = datetime.fromisoformat(event_time)
    order = db.get(Order, order_id)
    if order is None or order.doctor_id != doctor.id and doctor.role != "admin":
        raise ValueError("医嘱不存在或非本人无权撤回")
    if order.status == "withdrawn":
        raise ValueError("医嘱已撤回，不能重复撤回")

    order.status = "withdrawn"
    order.withdraw_reason = reason
    order.withdrawn_at = event_time
    order.version += 1
    db.flush()
    record_event(
        db, patient_id=order.patient_id, aggregate="order", aggregate_id=order.id,
        event_type="order.withdrawn", event_time=event_time,
        actor_type="staff", actor_id=doctor.id, actor_name=doctor.name,
        summary=f"医生 {doctor.name} 撤回医嘱 #{order.id}：{reason}（原始医嘱保留不改写）",
        data={"reason": reason, "version": order.version},
    )
    db.commit()
    return order


def order_type_label(t: str) -> str:
    return {"follow_adjust": "随访计划调整", "medication": "用药",
            "exam": "检查", "other": "其他"}.get(t, t)


# ---------------- 关闭升级单 ----------------

def close_escalation(db: Session, esc_id: int, staff: Staff, basis: str,
                     frozen_disposition: str = "auto",
                     event_time: datetime | None = None) -> Escalation:
    event_time = event_time or datetime.utcnow()
    esc = get_escalation(db, esc_id)
    if not basis.strip():
        raise ValueError("关闭升级单必须填写关闭依据")
    if esc.status in ("referral_requested",):
        raise ValueError("转诊尚未确认，不能关闭升级单")

    resumed, cancelled = _dispose_frozen_tasks(db, esc, staff, event_time,
                                               frozen_disposition)

    esc.status = "closed"
    esc.active_guard = None
    esc.closed_at = event_time
    esc.closed_by_id = staff.id
    esc.closure_basis = basis
    db.flush()
    record_event(
        db, patient_id=esc.patient_id, aggregate="escalation", aggregate_id=esc.id,
        event_type="escalation.closed", event_time=event_time,
        actor_type="staff", actor_id=staff.id, actor_name=staff.name,
        summary=f"升级单 #{esc.id} 关闭。依据：{basis}",
        data={"basis": basis, "resumed_tasks": resumed, "cancelled_tasks": cancelled},
    )
    db.commit()
    return esc


def _dispose_frozen_tasks(db: Session, esc: Escalation, staff: Staff,
                          event_time: datetime, disposition: str) -> tuple[list, list]:
    tasks = db.scalars(
        select(FollowUpTask).where(
            FollowUpTask.patient_id == esc.patient_id,
            FollowUpTask.status == "frozen",
            FollowUpTask.escalation_id == esc.id,
        )
    ).all()
    now = event_time
    resumed, cancelled = [], []
    for t in tasks:
        keep = (
            disposition == "resume"
            or (disposition == "auto" and t.due_at >= now)
        )
        if keep:
            t.status = "scheduled"
            t.escalation_id = None
            resumed.append(t.id)
            record_event(
                db, patient_id=esc.patient_id, aggregate="task", aggregate_id=t.id,
                event_type="task.resumed", event_time=event_time,
                actor_type="staff", actor_id=staff.id, actor_name=staff.name,
                summary=f"升级单 #{esc.id} 关闭，普通随访任务恢复：{t.title}",
                data={"escalation_id": esc.id},
            )
        else:
            t.status = "cancelled"
            t.cancel_reason = f"升级单 #{esc.id} 处置期间到期，已被升级随访替代"
            t.closed_at = event_time
            cancelled.append(t.id)
            record_event(
                db, patient_id=esc.patient_id, aggregate="task", aggregate_id=t.id,
                event_type="task.cancelled", event_time=event_time,
                actor_type="staff", actor_id=staff.id, actor_name=staff.name,
                summary=f"普通随访任务取消（升级单 #{esc.id} 已替代）：{t.title}",
                data={"escalation_id": esc.id},
            )
    return resumed, cancelled
