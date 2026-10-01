"""人工队列与后台巡检触发（运维/护士站）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import ManualQueueItem, Notification, Patient
from ..security import CurrentUser, current_user, require_roles
from ..services import queue as queue_svc
from ..services import tasks as task_svc
from ..services import notifications as notify_svc
from .. import serializers as ser

router = APIRouter(prefix="/api/queue", tags=["queue"])


@router.get("")
def list_queue(status: str = "open",
               user: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(ManualQueueItem, Patient)
        .join(Patient, Patient.id == ManualQueueItem.patient_id)
        .where(ManualQueueItem.status == status)
        .order_by(ManualQueueItem.created_at)
    ).all()
    return [ser.queue_out(q, user, p) for q, p in rows]


class ClaimBody(BaseModel):
    pass


@router.post("/{item_id}/claim")
def claim(item_id: int, user: CurrentUser = Depends(require_roles("nurse", "admin")),
          db: Session = Depends(get_db)):
    try:
        q = queue_svc.claim(db, item_id, user.id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    return {"ok": True, "status": q.status}


class ResolveBody(BaseModel):
    resolution: str


@router.post("/{item_id}/resolve")
def resolve(item_id: int, body: ResolveBody,
            user: CurrentUser = Depends(require_roles("nurse", "admin")),
            db: Session = Depends(get_db)):
    try:
        q = queue_svc.resolve(db, item_id, user.id, user.name, body.resolution)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    return {"ok": True, "status": q.status}


@router.get("/notifications")
def list_notifications(user: CurrentUser = Depends(require_roles("admin")),
                       db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Notification).order_by(Notification.created_at.desc()).limit(100)
    ).all()
    return [ser.notification_out(n) for n in rows]


@router.post("/sweep", include_in_schema=False)
def sweep(user: CurrentUser = Depends(require_roles("admin")),
          db: Session = Depends(get_db)):
    """手动触发后台巡检（演示与测试用；生产由后台线程定时执行）。"""
    delivered = notify_svc.deliver_pending(db)
    sla = task_svc.sweep_sla(db)
    dead = task_svc.sweep_dead_notifications(db)
    return {"notifications": delivered, "sla": sla, "dead_queued": dead}
