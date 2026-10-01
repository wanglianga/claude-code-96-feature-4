"""药师：仅处理用药相互作用与用药建议。

硬边界：药师的任何操作都不会修改 order 内容、order 状态（active/withdrawn 是医生
的诊疗结论）或升级单状态；药师只能追加 PharmacyReview，并把审方标记回写到
orders.pharmacy_status（审方流转字段，非诊疗结论）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import FollowUpTask, MedicationPlan, Order, PharmacyReview, Staff
from ..rules import check_interactions
from ..events import record_event
from . import notifications as notify


def review_medication(db: Session, patient_id: int, pharmacist: Staff,
                      payload: dict) -> PharmacyReview:
    event_time = payload.get("event_time") or datetime.utcnow()
    if isinstance(event_time, str):
        event_time = datetime.fromisoformat(event_time)
    advice = (payload.get("advice") or "").strip()
    detail = (payload.get("interaction_detail") or "").strip()
    found = bool(payload.get("interaction_found"))

    # 若指定了医嘱，必须是用药类；药师不能对非用药医嘱下结论
    order = None
    if payload.get("order_id"):
        order = db.get(Order, payload["order_id"])
        if order is None or order.patient_id != patient_id:
            raise ValueError("医嘱不存在")
        if order.order_type != "medication":
            raise PermissionError("药师只能处理用药类医嘱")

    # 自动相互作用校验（结合在用药品 + 本次医嘱文本）
    plan_drugs = [m.drug_name for m in db.scalars(
        select(MedicationPlan).where(
            MedicationPlan.patient_id == patient_id,
            MedicationPlan.active.is_(True),
        )
    ).all()]
    auto_hits = []
    if order is not None:
        auto_hits = check_interactions(plan_drugs + [order.content])
    if auto_hits and not detail:
        detail = "；".join(auto_hits)
        found = True

    review = PharmacyReview(
        patient_id=patient_id,
        order_id=order.id if order else None,
        escalation_id=payload.get("escalation_id"),
        pharmacist_id=pharmacist.id,
        interaction_found=found,
        interaction_detail=detail,
        advice=advice,
        event_time=event_time,
    )
    db.add(review)
    db.flush()

    if order is not None:
        # 只更新审方流转标记，不改 order.status/content
        order.pharmacy_status = "interaction_flag" if found else "reviewed"

    label = "发现用药相互作用" if found else "用药审方通过"
    record_event(
        db, patient_id=patient_id, aggregate="pharmacy", aggregate_id=review.id,
        event_type="pharmacy.reviewed", event_time=event_time,
        actor_type="staff", actor_id=pharmacist.id, actor_name=pharmacist.name,
        summary=f"药师 {pharmacist.name} {label}：{detail or advice or '无'}（不改变诊疗结论）",
        data={"interaction_found": found, "interaction_detail": detail,
              "advice": advice, "order_id": review.order_id},
    )

    # 通知主管医生“药师建议”，但不自动改医嘱
    if order is not None and found:
        notify.enqueue(
            db, ntype="pharmacy_flag",
            title=f"药师标记用药相互作用（医嘱 #{order.id}）",
            body=f"{detail}；建议：{advice}", target_staff_id=order.doctor_id,
            channel="im", patient_id=patient_id,
        )
    db.commit()
    return review


def medication_view(db: Session, patient_id: int) -> dict:
    plans = db.scalars(
        select(MedicationPlan).where(MedicationPlan.patient_id == patient_id)
    ).all()
    orders = db.scalars(
        select(Order).where(
            Order.patient_id == patient_id,
            Order.order_type == "medication",
        )
    ).all()
    drugs = [m.drug_name for m in plans if m.active]
    for o in orders:
        if o.status == "active":
            drugs.append(o.content)
    return {
        "plans": plans,
        "orders": orders,
        "auto_interactions": check_interactions(drugs),
    }


def complete_med_task(db: Session, task_id: int, pharmacist: Staff, note: str) -> FollowUpTask:
    """药师只能完成与用药相关的任务，且不能改动诊疗结论。"""
    t = db.get(FollowUpTask, task_id)
    if t is None:
        raise ValueError("任务不存在")
    if "药" not in t.title and t.assignee_role != "pharmacist":
        raise PermissionError("药师只能处理用药相关任务")
    if t.status not in ("scheduled", "in_progress"):
        raise ValueError(f"任务状态 {t.status}，不能完成")
    t.status = "completed"
    t.closure_basis = f"药师 {pharmacist.name} 完成：{note}"
    t.closed_at = datetime.utcnow()
    db.flush()
    record_event(
        db, patient_id=t.patient_id, aggregate="task", aggregate_id=t.id,
        event_type="task.completed", actor_type="staff",
        actor_id=pharmacist.id, actor_name=pharmacist.name,
        summary=f"药师完成用药任务 #{t.id}：{note}",
    )
    db.commit()
    return t
