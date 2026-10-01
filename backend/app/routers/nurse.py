from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Staff
from ..security import CurrentUser, require_roles
from ..services import escalation as esc_svc
from ..services import tasks as task_svc

router = APIRouter(prefix="/api/nurse", tags=["nurse"])


class ScreenBody(BaseModel):
    action: str           # phone_callback / ed_advice / referral_request / note
    note: str = ""
    target: str | None = None          # referral 目标
    reached: bool | None = None        # phone_callback
    outcome: str | None = None
    refused: bool | None = None
    event_time: datetime | None = None


@router.post("/escalations/{esc_id}/screen")
def screen(esc_id: int, body: ScreenBody,
           user: CurrentUser = Depends(require_roles("nurse")),
           db: Session = Depends(get_db)):
    nurse = db.get(Staff, user.id)
    try:
        res = esc_svc.nurse_screen(
            db, esc_id, nurse, body.action, body.note,
            body.event_time,
            extra={"target": body.target, "reached": body.reached,
                   "outcome": body.outcome, "refused": body.refused},
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "status": res["escalation"].status,
            "referral_id": getattr(res.get("referral"), "id", None),
            "referral_created": res.get("referral_created")}


class CompleteBody(BaseModel):
    basis: str


@router.post("/tasks/{task_id}/start")
def start(task_id: int, user: CurrentUser = Depends(require_roles("nurse")),
          db: Session = Depends(get_db)):
    try:
        t = task_svc.start_task(db, task_id, user)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "status": t.status}


@router.post("/tasks/{task_id}/complete")
def complete(task_id: int, body: CompleteBody,
             user: CurrentUser = Depends(require_roles("nurse")),
             db: Session = Depends(get_db)):
    try:
        t = task_svc.complete_task(db, task_id, user, body.basis)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "status": t.status, "closure_basis": t.closure_basis}


class CloseBody(BaseModel):
    basis: str
    frozen_disposition: str = "auto"   # auto / resume / cancel
    event_time: datetime | None = None


@router.post("/escalations/{esc_id}/close")
def close(esc_id: int, body: CloseBody,
          user: CurrentUser = Depends(require_roles("nurse", "doctor", "admin")),
          db: Session = Depends(get_db)):
    staff = db.get(Staff, user.id)
    try:
        e = esc_svc.close_escalation(
            db, esc_id, staff, body.basis, body.frozen_disposition, body.event_time
        )
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    return {"ok": True, "status": e.status, "closed_at": e.closed_at.isoformat() + "Z"}
