from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Order, Staff
from ..security import CurrentUser, require_roles
from ..services import pharmacy as ph_svc
from .. import serializers as ser

router = APIRouter(prefix="/api/pharmacist", tags=["pharmacist"])


class ReviewBody(BaseModel):
    patient_id: int
    order_id: int | None = None
    escalation_id: int | None = None
    interaction_found: bool = False
    interaction_detail: str = ""
    advice: str = ""
    event_time: datetime | None = None


@router.post("/reviews")
def add_review(body: ReviewBody,
               user: CurrentUser = Depends(require_roles("pharmacist")),
               db: Session = Depends(get_db)):
    pharmacist = db.get(Staff, user.id)
    try:
        rv = ph_svc.review_medication(db, body.patient_id, pharmacist, body.model_dump())
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "review_id": rv.id,
            "pharmacy_status": db.get(Order, body.order_id).pharmacy_status
            if body.order_id else None}


@router.get("/patients/{pid}/medication")
def medication(pid: int, user: CurrentUser = Depends(require_roles("pharmacist")),
               db: Session = Depends(get_db)):
    view = ph_svc.medication_view(db, pid)
    return {
        "plans": [
            {"id": m.id, "drug_name": m.drug_name, "dosage": m.dosage,
             "frequency": m.frequency, "active": m.active}
            for m in view["plans"]
        ],
        "orders": [
            {**ser.order_out(o, user), "event_time": ser.dt(o.event_time)}
            for o in view["orders"]
        ],
        "auto_interactions": view["auto_interactions"],
    }
