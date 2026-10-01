"""统一事件记录器：所有状态变更都经此追加事件，供时间线追溯。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from .models import Event


def record_event(
    db: Session,
    *,
    patient_id: int,
    aggregate: str,
    event_type: str,
    summary: str,
    actor_type: str = "system",
    actor_id: int | None = None,
    actor_name: str = "系统",
    aggregate_id: int | None = None,
    event_time: datetime | None = None,
    data: dict | None = None,
    flush: bool = True,
) -> Event:
    ev = Event(
        patient_id=patient_id,
        aggregate=aggregate,
        aggregate_id=aggregate_id,
        event_type=event_type,
        actor_type=actor_type,
        actor_id=actor_id,
        actor_name=actor_name,
        summary=summary,
        data=data or {},
        event_time=event_time or datetime.utcnow(),
    )
    db.add(ev)
    if flush:
        db.flush()
    return ev
