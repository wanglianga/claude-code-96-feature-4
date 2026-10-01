"""出院登记与分级随访计划生成。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import FollowUpTask, Patient
from ..rules import build_plan
from ..events import record_event


def discharge_and_plan(db: Session, patient: Patient, discharge_dt: datetime) -> list[FollowUpTask]:
    """为出院患者生成分级随访任务（幂等：同患者已有任务则不重复生成）。"""
    existing = db.scalar(
        select(FollowUpTask.id).where(
            FollowUpTask.patient_id == patient.id,
            FollowUpTask.kind == "auto",
        )
    )
    if existing:
        return list(db.scalars(
            select(FollowUpTask).where(FollowUpTask.patient_id == patient.id)
        ).all())

    plan = build_plan(patient, discharge_dt)
    tasks: list[FollowUpTask] = []
    for step in plan:
        t = FollowUpTask(
            patient_id=patient.id,
            level=step["level"],
            kind="auto",
            status="scheduled",
            title=step["title"],
            reason=step["reason"],
            due_at=step["due_at"],
            assignee_role="nurse",
        )
        db.add(t)
        tasks.append(t)
    db.flush()
    for t in tasks:
        record_event(
            db,
            patient_id=patient.id,
            aggregate="task",
            aggregate_id=t.id,
            event_type="task.scheduled",
            event_time=t.due_at,
            summary=f"自动生成分级随访任务 [{t.level}] {t.title}，应办 {t.due_at:%Y-%m-%d %H:%M}",
            data={"level": t.level, "due_at": t.due_at.isoformat(), "kind": "auto"},
        )
    return tasks
