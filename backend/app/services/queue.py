"""人工队列：拒接联系、授权过期、图片不可读、SLA 超时升级、通知死信等。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ManualQueueItem
from ..events import record_event


def enqueue_manual(
    db: Session,
    *,
    patient_id: int,
    reason_type: str,
    detail: str,
    escalation_id: int | None = None,
    report_id: int | None = None,
    commit: bool = False,
) -> ManualQueueItem:
    # 患者级原因（拒联系/授权过期/通知死信）跨上报去重，只保留一个待办；
    # 报告级原因（图片不可读/SLA）按聚合去重。
    patient_level = reason_type in ("contact_refused", "consent_expired", "notify_dead")
    stmt = select(ManualQueueItem.id).where(
        ManualQueueItem.patient_id == patient_id,
        ManualQueueItem.reason_type == reason_type,
        ManualQueueItem.status.in_(["open", "claimed"]),
    )
    if not patient_level:
        if escalation_id is not None:
            stmt = stmt.where(ManualQueueItem.escalation_id == escalation_id)
        else:
            stmt = stmt.where(ManualQueueItem.escalation_id.is_(None))
        if report_id is not None:
            stmt = stmt.where(ManualQueueItem.report_id == report_id)
        else:
            stmt = stmt.where(ManualQueueItem.report_id.is_(None))
    exists = db.scalar(stmt)
    if exists:
        return db.get(ManualQueueItem, exists)

    item = ManualQueueItem(
        patient_id=patient_id,
        escalation_id=escalation_id,
        report_id=report_id,
        reason_type=reason_type,
        detail=detail,
    )
    db.add(item)
    db.flush()
    record_event(
        db,
        patient_id=patient_id,
        aggregate="queue",
        aggregate_id=item.id,
        event_type="manual_queued",
        summary=f"转入人工队列：{reason_label(reason_type)}",
        data={"reason_type": reason_type, "detail": detail},
    )
    if commit:
        db.commit()
    return item


def claim(db: Session, item_id: int, staff_id: int) -> ManualQueueItem:
    item = db.get(ManualQueueItem, item_id)
    if item is None:
        raise ValueError("队列事项不存在")
    if item.status != "open":
        raise ValueError("该事项已被处理或认领")
    item.status = "claimed"
    item.claimed_by_id = staff_id
    db.flush()
    record_event(
        db,
        patient_id=item.patient_id,
        aggregate="queue",
        aggregate_id=item.id,
        event_type="manual_claimed",
        actor_type="staff",
        actor_id=staff_id,
        summary="人工队列事项已认领",
    )
    return item


def resolve(db: Session, item_id: int, staff_id: int, staff_name: str, resolution: str):
    item = db.get(ManualQueueItem, item_id)
    if item is None or item.status not in ("open", "claimed"):
        raise ValueError("事项不存在或已关闭")
    item.status = "resolved"
    item.resolved_by_id = staff_id
    item.resolution = resolution
    item.resolved_at = datetime.utcnow()
    db.flush()
    record_event(
        db,
        patient_id=item.patient_id,
        aggregate="queue",
        aggregate_id=item.id,
        event_type="manual_resolved",
        actor_type="staff",
        actor_id=staff_id,
        actor_name=staff_name,
        summary=f"人工队列关闭：{resolution}",
    )
    return item


def reason_label(code: str) -> str:
    return {
        "contact_refused": "患者拒绝联系",
        "consent_expired": "随访授权已过期",
        "image_unreadable": "上报图片无法读取",
        "sla_breach": "高风险事件超时未闭环",
        "notify_dead": "通知多次投递失败",
        "other": "其他需人工介入",
    }.get(code, code)
