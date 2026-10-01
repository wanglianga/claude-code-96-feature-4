from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Staff
from ..security import CurrentUser, require_roles
from ..services import escalation as esc_svc

router = APIRouter(prefix="/api/doctor", tags=["doctor"])


class OrderBody(BaseModel):
    patient_id: int
    order_type: str = "other"   # follow_adjust / medication / exam / other
    content: str
    escalation_id: int | None = None
    task_title: str | None = None
    due_at: datetime | None = None
    event_time: datetime | None = None


@router.post("/orders")
def add_order(body: OrderBody,
              user: CurrentUser = Depends(require_roles("doctor")),
              db: Session = Depends(get_db)):
    doctor = db.get(Staff, user.id)
    try:
        o = esc_svc.add_doctor_order(db, body.patient_id, doctor, body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "order_id": o.id, "status": o.status,
            "pharmacy_status": o.pharmacy_status}


class WithdrawBody(BaseModel):
    reason: str
    event_time: datetime | None = None


@router.post("/orders/{order_id}/withdraw")
def withdraw(order_id: int, body: WithdrawBody,
             user: CurrentUser = Depends(require_roles("doctor", "admin")),
             db: Session = Depends(get_db)):
    doctor = db.get(Staff, user.id)
    try:
        o = esc_svc.withdraw_order(db, order_id, doctor, body.reason, body.event_time)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "status": o.status}


class ReferralDecision(BaseModel):
    decision: str   # confirm / reject
    note: str = ""
    event_time: datetime | None = None


@router.post("/referrals/{referral_id}/decision")
def decide(referral_id: int, body: ReferralDecision,
           user: CurrentUser = Depends(require_roles("doctor", "admin")),
           db: Session = Depends(get_db)):
    staff = db.get(Staff, user.id)
    try:
        r = esc_svc.decide_referral(
            db, referral_id, staff, body.decision, body.note, body.event_time
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "status": r.status}
