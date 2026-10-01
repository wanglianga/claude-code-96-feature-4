"""任务完成/执行（护士）与后台巡检（SLA 超时持续提醒 → 人工队列；通知死信 → 人工队列）。"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Escalation, FollowUpTask, Notification, Staff
from ..events import record_event
from . import notifications as notify
from . import queue as manual_queue


def start_task(db: Session, task_id: int, staff) -> FollowUpTask:
    t = db.get(FollowUpTask, task_id)
    if t is None:
        raise ValueError("任务不存在")
    if t.status != "scheduled":
        raise ValueError(f"任务状态 {t.status}，不能开始")
    t.status = "in_progress"
    db.commit()
    return t


def complete_task(db: Session, task_id: int, staff, basis: str) -> FollowUpTask:
    t = db.get(FollowUpTask, task_id)
    if t is None:
        raise ValueError("任务不存在")
    if t.status not in ("scheduled", "in_progress"):
        raise ValueError(f"任务状态 {t.status}，不能完成")
    if not basis.strip():
        raise ValueError("完成任务必须填写处理依据")
    t.status = "completed"
    t.closure_basis = f"{staff.name}：{basis}"
    t.closed_at = datetime.utcnow()
    db.flush()
    record_event(
        db, patient_id=t.patient_id, aggregate="task", aggregate_id=t.id,
        event_type="task.completed", actor_type="staff",
        actor_id=staff.id, actor_name=staff.name,
        summary=f"随访任务完成：{t.title}；依据：{basis}",
    )
    db.commit()
    return t


def _duty_nurses(db: Session) -> list[Staff]:
    return db.scalars(
        select(Staff).where(Staff.role == "nurse", Staff.active.is_(True))
    ).all()


def sweep_sla(db: Session, now: datetime | None = None) -> dict:
    """对未在时限内闭环的高风险事件持续提醒；超过 N 次仍未闭环则转人工队列。"""
    now = now or datetime.utcnow()
    active = db.scalars(
        select(Escalation).where(
            Escalation.status.in_(
                ["open", "phone_followup", "ed_advised", "referral_requested"]
            )
        )
    ).all()
    reminded = queued = 0
    for esc in active:
        if esc.sla_due_at > now:
            continue
        interval = timedelta(seconds=settings.SLA_REMINDER_INTERVAL_SECONDS)
        if esc.last_reminder_at and now - esc.last_reminder_at < interval:
            continue
        esc.reminder_count += 1
        esc.last_reminder_at = now
        overdue_min = int((now - esc.sla_due_at).total_seconds() // 60)
        for n in _duty_nurses(db):
            notify.enqueue(
                db, ntype="sla_overdue",
                title=f"【SLA 超时 #{esc.reminder_count}】升级单 #{esc.id} 已超 {overdue_min} 分钟未闭环",
                body=esc.risk_summary, target_staff_id=n.id, channel="im",
                patient_id=esc.patient_id,
            )
        record_event(
            db, patient_id=esc.patient_id, aggregate="escalation", aggregate_id=esc.id,
            event_type="escalation.sla_reminder",
            summary=f"高风险升级单 #{esc.id} 超 SLA {overdue_min} 分钟，第 {esc.reminder_count} 次持续提醒",
            data={"reminder_count": esc.reminder_count, "overdue_minutes": overdue_min},
        )
        reminded += 1
        if (
            not esc.queued_manual
            and esc.reminder_count >= settings.SLA_QUEUE_AFTHER_REMINDERS
        ):
            manual_queue.enqueue_manual(
                db, patient_id=esc.patient_id, escalation_id=esc.id,
                reason_type="sla_breach",
                detail=f"升级单 #{esc.id} 已 {esc.reminder_count} 次提醒仍未闭环，超 {overdue_min} 分钟",
            )
            esc.queued_manual = True
            queued += 1
    if reminded:
        db.commit()
    return {"reminded_escalations": reminded, "queued": queued}


def sweep_dead_notifications(db: Session, now: datetime | None = None) -> int:
    """通知重试耗尽转人工（避免异步通知失败导致漏随访无人知晓）。"""
    now = now or datetime.utcnow()
    dead = db.scalars(select(Notification).where(Notification.status == "dead")).all()
    count = 0
    for n in dead:
        if n.patient_id is not None:
            manual_queue.enqueue_manual(
                db,
                patient_id=n.patient_id,
                reason_type="notify_dead",
                detail=f"通知《{n.title}》投递 {n.attempts} 次仍失败：{n.last_error}",
            )
            count += 1
        n.status = "dead_queued"
    db.commit()
    return count
