import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Patient, Staff
from ..security import CurrentUser, current_user, issue_token

router = APIRouter(prefix="/api/auth", tags=["auth"])


def hash_password(p: str) -> str:
    return hashlib.sha256(("fu:" + p).encode()).hexdigest()


class StaffLogin(BaseModel):
    username: str
    password: str


class PatientLogin(BaseModel):
    code: str          # 病案号
    id_card_tail: str  # 身份证后4位（受限入口的弱身份校验）
    name: str | None = None


@router.post("/staff/login")
def staff_login(body: StaffLogin, db: Session = Depends(get_db)):
    staff = db.scalar(select(Staff).where(Staff.username == body.username))
    if not staff or staff.password_hash != hash_password(body.password):
        raise HTTPException(status_code=401, detail="工号或密码错误")
    if not staff.active:
        raise HTTPException(status_code=403, detail="账号已停用")
    token = issue_token(f"staff:{staff.id}", staff.name)
    return {"token": token, "user": {
        "id": staff.id, "name": staff.name, "role": staff.role,
        "department": staff.department, "kind": "staff"}}


@router.post("/patient/login")
def patient_login(body: PatientLogin, db: Session = Depends(get_db)):
    # 受限入口：病案号 + 身份证后4位；不暴露密码体系
    p = db.scalar(select(Patient).where(Patient.code == body.code.strip()))
    if not p or p.id_card_tail != body.id_card_tail.strip():
        raise HTTPException(status_code=401, detail="病案号或身份证后4位不匹配")
    if body.name and body.name.strip() != p.name:
        raise HTTPException(status_code=401, detail="姓名与病案号不匹配")
    token = issue_token(f"patient:{p.id}", p.name)
    return {"token": token, "user": {
        "id": p.id, "name": p.name, "code": p.code, "kind": "patient"}}


@router.get("/me")
def me(user: CurrentUser = Depends(current_user)):
    return {"id": user.id, "name": user.name, "role": user.role, "kind": user.kind}
