"""异步通知 outbox：业务事务内只写 outbox 行，后台投递；失败指数退避重试，
超过次数置 dead 并可转人工，绝不因通知失败而回滚业务。"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Escalation, Notification, Staff
from ..events import record_event


def enqueue(
    db: Session,
    *,
    ntype: str,
    title: str,
    body: str,
    target_staff_id: int | None = None,
    target_phone: str = "",
    channel: str = "im",
    patient_id: int | None = None,
    max_attempts: int | None = None,
    commit: bool = False,
) -> Notification:
    staff = db.get(Staff, target_staff_id) if target_staff_id else None
    n = Notification(
        channel=channel,
        patient_id=patient_id,
        target_staff_id=target_staff_id,
        target_phone=target_phone or (getattr(staff, "name", "") and ""),
        ntype=ntype,
        title=title,
        body=body,
        max_attempts=max_attempts or settings.NOTIFY_MAX_ATTEMPTS,
        next_attempt_at=datetime.utcnow(),
    )
    db.add(n)
    db.flush()
    if patient_id is not None:
        record_event(
            db,
            patient_id=patient_id,
            aggregate="notification",
            aggregate_id=n.id,
            event_type="notification.enqueued",
            summary=f"通知已入队：{title}",
            data={"ntype": ntype, "target_staff_id": target_staff_id,
                  "channel": channel},
        )
    if commit:
        db.commit()
    return n


def _deliver_one(db: Session, n: Notification) -> bool:
    """模拟真实通道（短信/IM）。Staff.notify_failing=True 时通道持续失败。"""
    staff = db.get(Staff, n.target_staff_id) if n.target_staff_id else None
    if staff is not None and staff.notify_failing:
        raise RuntimeError("通道异常：运营商网关 503")
    return True


def deliver_pending(db: Session, now: datetime | None = None) -> dict:
    now = now or datetime.utcnow()
    pending = db.scalars(
        select(Notification)
        .where(Notification.status.in_(["pending", "failed"]))
        .where(Notification.next_attempt_at <= now)
        .limit(50)
    ).all()
    sent = failed = dead = 0
    for n in pending:
        n.attempts += 1
        try:
            _deliver_one(db, n)
            n.status = "sent"
            n.sent_at = now
            n.last_error = ""
            sent += 1
        except Exception as exc:  # 通道失败：退避重试，不影响业务
            n.last_error = str(exc)[:300]
            if n.attempts >= n.max_attempts:
                n.status = "dead"
                dead += 1
            else:
                n.status = "failed"
                n.next_attempt_at = now + timedelta(
                    seconds=settings.NOTIFY_BACKOFF_SECONDS * n.attempts
                )
                failed += 1
    if pending:
        db.commit()
    return {"processed": len(pending), "sent": sent, "retry": failed, "dead": dead}


def dead_notifications(db: Session) -> list[Notification]:
    return db.scalars(
        select(Notification).where(Notification.status == "dead")
    ).all()
