"""按角色 × 字段的授权与脱敏序列化。

矩阵（viewer 为 staff 角色；患者只能看本人，由路由层保证）：

字段                    nurse   doctor  pharmacist
患者姓名                全      全       张**（姓氏+掩码）
病案号/科室/手术/出院    全      全       全
手机                    全      全       138****1234
身份证后4位             隐藏    隐藏     隐藏
过敏史                  全      全       全（用药安全必需）
症状/症状描述           全      全       隐藏
体温/血压               全      全       隐藏
用药依从性              全      全       全（用药相关）
上报图片                全      全       不可见
非用药医嘱内容          全      全       隐藏
护士初筛/电话回访明细   全      全       隐藏
"""
from __future__ import annotations

from datetime import datetime

from .models import (
    Callback,
    Escalation,
    Event,
    FollowUpTask,
    ManualQueueItem,
    MedicationPlan,
    Notification,
    Order,
    Patient,
    PharmacyReview,
    Referral,
    Report,
    ReportImage,
    Staff,
    TriageAction,
)

MASK = "******"
HIDDEN = "（无权限查看）"


def dt(v: datetime | None):
    return v.isoformat() + "Z" if v else None


def mask_phone(p: str | None) -> str:
    if not p:
        return ""
    if len(p) >= 7:
        return p[:3] + "****" + p[-4:]
    return MASK


def mask_name(name: str) -> str:
    if not name:
        return ""
    if len(name) == 1:
        return name + "**"
    return name[0] + "*" * max(1, len(name) - 1)


# 药师可见的事件白名单（其余在时间线中被过滤或掩码）
PHARMACIST_EVENT_OK = {
    "escalation.opened",
    "escalation.closed",
    "order.added",
    "order.withdrawn",
    "pharmacy.reviewed",
    "task.scheduled",
    "task.cancelled",
    "task.supersedes",
}
# 患者可见的事件白名单
PATIENT_EVENT_OK = {
    "report.submitted",
    "report.merged",
    "escalation.opened",
    "escalation.closed",
    "escalation.worsening",
    "nurse.phone_callback",
    "nurse.ed_advice",
    "nurse.referral_request",
    "referral.requested",
    "referral.confirmed",
    "referral.rejected",
    "order.added",
    "order.withdrawn",
    "pharmacy.reviewed",
    "task.scheduled",
    "task.frozen",
    "task.resumed",
    "task.cancelled",
    "task.completed",
    "task.supersedes",
    "manual_queued",
    "manual_resolved",
}


def viewer_role(viewer) -> str:
    return "patient" if getattr(viewer, "is_patient", False) else viewer.role


def patient_brief(p: Patient, viewer) -> dict:
    role = viewer_role(viewer)
    if role == "pharmacist":
        return {
            "id": p.id,
            "code": p.code,
            "name": mask_name(p.name),
            "department": p.department,
            "surgery_type": p.surgery_type,
        }
    return {
        "id": p.id,
        "code": p.code,
        "name": p.name,
        "department": p.department,
        "surgery_type": p.surgery_type,
        "discharge_date": p.discharge_date,
    }


def patient_full(p: Patient, viewer) -> dict:
    role = viewer_role(viewer)
    is_ph = role == "pharmacist"
    base = {
        "id": p.id,
        "code": p.code,
        "gender": p.gender,
        "birth_date": MASK if is_ph else p.birth_date,
        "department": p.department,
        "surgery_type": p.surgery_type,
        "surgery_date": p.surgery_date,
        "discharge_date": p.discharge_date,
        "discharge_orders": p.discharge_orders,
        "allergy": p.allergy or "无",  # 过敏史：三类医护均可见（用药/处置安全）
        "consent_until": dt(p.consent_until),
        "contact_refused": p.contact_refused,
    }
    if role == "pharmacist":
        base["name"] = mask_name(p.name)
        base["phone"] = mask_phone(p.phone)
        base["id_card_tail"] = MASK
    else:
        base["name"] = p.name
        base["phone"] = p.phone
        base["id_card_tail"] = MASK  # 身份证号不对任何医护界面展示
    return base


def report_out(r: Report, viewer, patient: Patient | None = None) -> dict:
    role = viewer_role(viewer)
    is_ph = role == "pharmacist"
    out = {
        "id": r.id,
        "channel": r.channel,
        "status": r.status,
        "adherence": r.adherence,  # 用药依从性：药师可见
        "high_risk": r.high_risk,
        "contact_ok": r.contact_ok,
        "event_time": dt(r.event_time),
        "received_at": dt(r.received_at),
        "escalation_id": r.escalation_id,
        "duplicate_of_id": r.duplicate_of_id,
    }
    if is_ph:
        out["symptoms"] = []
        out["symptom_text"] = HIDDEN
        out["temperature"] = None
        out["systolic"] = None
        out["diastolic"] = None
        out["risk_hits"] = [{"code": h["code"], "label": "高风险症状（细节已隐藏）"}
                            for h in (r.risk_hits or [])]
        out["images"] = []
    else:
        out["symptoms"] = r.symptoms or []
        out["symptom_text"] = r.symptom_text
        out["temperature"] = r.temperature
        out["systolic"] = r.systolic
        out["diastolic"] = r.diastolic
        out["risk_hits"] = r.risk_hits or []
        out["images"] = [image_out(i, viewer) for i in getattr(r, "images", [])]
    return out


def image_out(i: ReportImage, viewer) -> dict:
    role = viewer_role(viewer)
    if role == "pharmacist":
        return {"id": i.id, "status": "hidden", "filename": HIDDEN}
    return {
        "id": i.id,
        "filename": i.filename,
        "content_type": i.content_type,
        "size": i.size,
        "sha256": i.sha256[:12],
        "status": i.status,
        "unreadable_reason": i.unreadable_reason,
        "url": f"/api/staff/images/{i.id}" if i.status == "ok" else None,
    }


def order_out(o: Order, viewer, doctor_name: str = "") -> dict | None:
    role = viewer_role(viewer)
    base = {
        "id": o.id,
        "order_type": o.order_type,
        "status": o.status,
        "doctor_name": doctor_name,
        "event_time": dt(o.event_time),
        "recorded_at": dt(o.recorded_at),
        "withdrawn_at": dt(o.withdrawn_at),
        "withdraw_reason": o.withdraw_reason,
        "pharmacy_status": o.pharmacy_status,
        "escalation_id": o.escalation_id,
    }
    if role == "pharmacist":
        if o.order_type != "medication":
            # 药师视图中不展示非用药医嘱内容
            return {**base, "content": HIDDEN, "order_type": o.order_type,
                    "_blocked": True}
    base["content"] = o.content
    return base


def task_out(t: FollowUpTask, viewer) -> dict:
    return {
        "id": t.id,
        "level": t.level,
        "kind": t.kind,
        "status": t.status,
        "title": t.title,
        "reason": t.reason,
        "due_at": dt(t.due_at),
        "assignee_role": t.assignee_role,
        "cancel_reason": t.cancel_reason,
        "superseded_by_task_id": t.superseded_by_task_id,
        "superseded_by_order_id": t.superseded_by_order_id,
        "escalation_id": t.escalation_id,
        "closure_basis": t.closure_basis,
        "closed_at": dt(t.closed_at),
    }


def referral_out(r: Referral, viewer, requester: str = "") -> dict:
    return {
        "id": r.id,
        "escalation_id": r.escalation_id,
        "target": r.target,
        "reason": r.reason,
        "status": r.status,
        "requested_by": requester,
        "request_event_time": dt(r.request_event_time),
        "recorded_at": dt(r.recorded_at),
        "confirmed_at": dt(r.confirmed_at),
        "confirmation_note": r.confirmation_note,
    }


def triage_out(a: TriageAction, nurse_name: str) -> dict:
    return {
        "id": a.id, "action": a.action, "note": a.note,
        "nurse_name": nurse_name,
        "event_time": dt(a.event_time), "recorded_at": dt(a.recorded_at),
    }


def callback_out(c: Callback, nurse_name: str) -> dict:
    return {
        "id": c.id, "reached": c.reached, "outcome": c.outcome, "note": c.note,
        "nurse_name": nurse_name,
        "event_time": dt(c.event_time), "recorded_at": dt(c.recorded_at),
    }


def review_out(rv: PharmacyReview, pharmacist_name: str) -> dict:
    return {
        "id": rv.id, "order_id": rv.order_id, "escalation_id": rv.escalation_id,
        "interaction_found": rv.interaction_found,
        "interaction_detail": rv.interaction_detail,
        "advice": rv.advice,
        "pharmacist_name": pharmacist_name,
        "event_time": dt(rv.event_time),
    }


def queue_out(q: ManualQueueItem, viewer, patient: Patient | None = None) -> dict:
    return {
        "id": q.id,
        "patient": patient_brief(patient, viewer) if patient else None,
        "reason_type": q.reason_type,
        "detail": q.detail,
        "status": q.status,
        "created_at": dt(q.created_at),
        "resolution": q.resolution,
        "resolved_at": dt(q.resolved_at),
    }


def notification_out(n: Notification) -> dict:
    return {
        "id": n.id, "channel": n.channel, "ntype": n.ntype,
        "title": n.title, "body": n.body,
        "status": n.status, "attempts": n.attempts,
        "max_attempts": n.max_attempts,
        "next_attempt_at": dt(n.next_attempt_at),
        "last_error": n.last_error,
        "sent_at": dt(n.sent_at),
        "target_staff_id": n.target_staff_id,
        "patient_id": n.patient_id,
    }


def escalation_out(e: Escalation, viewer, patient: Patient | None = None) -> dict:
    role = viewer_role(viewer)
    out = {
        "id": e.id,
        "patient_id": e.patient_id,
        "patient": patient_brief(patient, viewer) if patient else None,
        "status": e.status,
        "frozen_task_ids": e.frozen_task_ids or [],
        "opened_at": dt(e.opened_at),
        "sla_due_at": dt(e.sla_due_at),
        "reminder_count": e.reminder_count,
        "last_reminder_at": dt(e.last_reminder_at),
        "queued_manual": e.queued_manual,
        "closed_at": dt(e.closed_at),
        "closure_basis": e.closure_basis,
        "risk_summary": e.risk_summary if role != "pharmacist" else "高风险事件（症状细节按权限隐藏）",
        "risk_hits": [] if role == "pharmacist" else (e.risk_hits or []),
    }
    return out


def event_out(ev: Event, viewer) -> dict | None:
    """按角色过滤/脱敏时间线事件。返回 None 表示该角色不可见此事件。"""
    role = viewer_role(viewer)
    etype = ev.event_type
    summary = ev.summary
    data = dict(ev.data or {})

    if role == "pharmacist":
        if etype not in PHARMACIST_EVENT_OK:
            return None
        if etype in ("escalation.opened",):
            summary = "患者触发高风险规则并创建升级任务（症状细节按药师权限隐藏）"
            data = {"risk_hits": []}
        if etype == "order.added" and data.get("order_type") != "medication":
            # 非用药医嘱对药师只留痕，不暴露内容
            summary = f"医生下达了一条非用药类医嘱（{data.get('order_type')}，药师不可见内容）"
            data = {"order_type": data.get("order_type"), "blocked": True}
    elif role == "patient":
        if etype not in PATIENT_EVENT_OK:
            return None
        if etype == "notification.enqueued":
            return None
        # 患者视角隐去内部操作细节字段
        for k in ("frozen_task_ids",):
            data.pop(k, None)
    # nurse / doctor / admin：完整可见

    return {
        "id": ev.id,
        "patient_id": ev.patient_id,
        "aggregate": ev.aggregate,
        "aggregate_id": ev.aggregate_id,
        "event_type": etype,
        "actor_name": ev.actor_name,
        "actor_type": ev.actor_type,
        "summary": summary,
        "data": data,
        "event_time": dt(ev.event_time),
        "recorded_at": dt(ev.recorded_at),
        "backdated": ev.event_time < ev.recorded_at.replace(tzinfo=None)
        if False
        else _is_backdated(ev),
    }


def _is_backdated(ev: Event) -> bool:
    # 容差 60 秒，区分“补录”与正常落库延迟
    return (ev.recorded_at - ev.event_time).total_seconds() > 60
