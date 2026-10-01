"""患者受限入口：只能访问本人数据；上传图片、提交上报、查看本人时间线。"""
from __future__ import annotations

import hashlib
import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Escalation, FollowUpTask, Patient, ReportImage
from ..security import CurrentUser, current_user
from ..services import reports as report_svc
from .. import serializers as ser

router = APIRouter(prefix="/api/patient", tags=["patient"])


def _me(user: CurrentUser, db: Session) -> Patient:
    if not user.is_patient:
        raise HTTPException(403, "该入口仅限患者")
    p = db.get(Patient, user.id)
    if p is None:
        raise HTTPException(404, "患者不存在")
    return p


class ReportBody(BaseModel):
    symptoms: list[str] = []
    symptom_text: str = ""
    temperature: float | None = None
    systolic: int | None = None
    diastolic: int | None = None
    adherence: str = "unknown"
    contact_ok: bool = True
    channel: str = "portal"
    event_time: datetime | None = None
    image_ids: list[int] = []
    idempotency_key: str | None = None


@router.post("/images")
async def upload_image(file: UploadFile = File(...),
                       user: CurrentUser = Depends(current_user),
                       db: Session = Depends(get_db)):
    p = _me(user, db)
    blob = await file.read()
    sha = hashlib.sha256(blob).hexdigest()
    img = ReportImage(
        filename=file.filename or "upload.bin",
        content_type=file.content_type or "application/octet-stream",
        size=len(blob),
        sha256=sha,
        status="pending",
    )

    readable, reason, ctype = _probe(blob, file.content_type)
    img.content_type = ctype
    if not readable:
        img.status = "unreadable"
        img.unreadable_reason = reason
    else:
        try:
            os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
            path = os.path.join(settings.UPLOAD_DIR, f"p{p.id}-{sha[:16]}")
            with open(path, "wb") as fh:
                fh.write(blob)
            img.stored_path = path
            img.status = "ok"
        except OSError as exc:
            img.status = "unreadable"
            img.unreadable_reason = f"服务端落盘失败：{exc}"

    db.add(img)
    db.commit()
    db.refresh(img)
    return ser.image_out(img, user)


def _probe(blob: bytes, claimed: str | None) -> tuple[bool, str, str]:
    """可读性校验：空文件/截断/魔数不符视为无法读取。"""
    if not blob:
        return False, "文件为空（0 字节）", claimed or "application/octet-stream"
    sigs = {
        b"\xff\xd8\xff": "image/jpeg",
        b"\x89PNG\r\n\x1a\n": "image/png",
        b"GIF87a": "image/gif",
        b"GIF89a": "image/gif",
    }
    detected = None
    for magic, ctype in sigs.items():
        if blob.startswith(magic):
            detected = ctype
            break
    if detected is None:
        # 允许声明的 webp/bmp，其它一律不可读
        if claimed in ("image/webp", "image/bmp") and len(blob) > 16:
            detected = claimed
        else:
            return False, "文件头损坏或不是受支持的图片格式", claimed or "application/octet-stream"
    # 截断粗检：声明 JPEG 但无 EOI
    if detected == "image/jpeg" and not blob.rstrip().endswith(b"\xff\xd9"):
        return False, "JPEG 数据不完整（疑似上传中断）", detected
    if detected == "image/png" and not blob.rstrip().endswith(b"IEND\xaeB`\x82"):
        return False, "PNG 数据不完整（疑似上传中断）", detected
    return True, "", detected


@router.post("/reports")
def submit(body: ReportBody, user: CurrentUser = Depends(current_user),
           db: Session = Depends(get_db)):
    p = _me(user, db)
    result = report_svc.submit_report(db, p, body.model_dump())
    r = result["report"]
    db.refresh(r)
    return {
        "report": ser.report_out(r, user, p),
        "created": result["created"],
        "duplicate": result["duplicate"],
        "high_risk": r.high_risk if r.status != "merged" else False,
        "escalation_id": r.escalation_id,
        "message": (
            "已收到，您的情况与之前上报一致，已为您合并，无需重复提交"
            if result["duplicate"] else
            "已收到。系统评估为高风险，已通知护士尽快与您联系"
            if (result.get("escalation") and r.status != "merged")
            else "已收到，护士将按随访计划与您联系"
        ),
    }


@router.get("/overview")
def overview(user: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    p = _me(user, db)
    tasks = db.scalars(
        select(FollowUpTask).where(FollowUpTask.patient_id == p.id)
        .order_by(FollowUpTask.due_at)
    ).all()
    return {
        "patient": {
            "name": p.name, "code": p.code, "surgery_type": p.surgery_type,
            "discharge_date": p.discharge_date,
            "consent_until": ser.dt(p.consent_until),
            "contact_refused": p.contact_refused,
            "allergy": p.allergy or "无",
        },
        "tasks": [ser.task_out(t, user) for t in tasks],
    }
