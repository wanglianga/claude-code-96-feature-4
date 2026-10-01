"""医护共用查询：患者列表/详情（脱敏）、任务板、升级单、时间线、图片读取（药师不可读图片）。"""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    Callback, Escalation, Event, FollowUpTask, ManualQueueItem, MedicationPlan,
    Order, Patient, PharmacyReview, Referral, Report, ReportImage, Staff,
    TriageAction,
)
from ..security import CurrentUser, current_user, require_roles
from .. import serializers as ser

router = APIRouter(prefix="/api/staff", tags=["staff"])


def _db_staff(user: CurrentUser, db: Session) -> Staff:
    s = db.get(Staff, user.id)
    if s is None:
        raise HTTPException(403, "非医护账号")
    return s


@router.get("/patients")
def list_patients(user: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    ps = db.scalars(select(Patient).order_by(Patient.id)).all()
    # 列表仅返回按角色裁剪后的简要字段（药师姓名掩码、无电话）
    return [ser.patient_brief(p, user) for p in ps]


@router.get("/patients/{pid}")
def patient_detail(pid: int, user: CurrentUser = Depends(current_user),
                   db: Session = Depends(get_db)):
    p = db.get(Patient, pid)
    if p is None:
        raise HTTPException(404, "患者不存在")
    meds = db.scalars(
        select(MedicationPlan).where(MedicationPlan.patient_id == pid)
    ).all()
    tasks = db.scalars(
        select(FollowUpTask).where(FollowUpTask.patient_id == pid)
        .order_by(FollowUpTask.due_at)
    ).all()
    orders = []
    for o in db.scalars(
        select(Order).where(Order.patient_id == pid).order_by(Order.event_time.desc())
    ).all():
        doc = db.get(Staff, o.doctor_id)
        oo = ser.order_out(o, user, doc.name if doc else "")
        if oo:
            orders.append(oo)
    reviews = []
    for rv in db.scalars(
        select(PharmacyReview).where(PharmacyReview.patient_id == pid)
        .order_by(PharmacyReview.event_time.desc())
    ).all():
        ph = db.get(Staff, rv.pharmacist_id)
        reviews.append(ser.review_out(rv, ph.name if ph else ""))
    return {
        "patient": ser.patient_full(p, user),
        "medications": [
            {"id": m.id, "drug_name": m.drug_name, "dosage": m.dosage,
             "frequency": m.frequency, "start_date": m.start_date,
             "end_date": m.end_date, "active": m.active}
            for m in meds
        ],
        "tasks": [ser.task_out(t, user) for t in tasks],
        "orders": orders,
        "pharmacy_reviews": reviews,
    }


@router.get("/tasks")
def task_board(status: str | None = None, level: str | None = None,
               user: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    stmt = select(FollowUpTask, Patient).join(
        Patient, Patient.id == FollowUpTask.patient_id
    ).order_by(FollowUpTask.due_at)
    if status:
        stmt = stmt.where(FollowUpTask.status == status)
    if level:
        stmt = stmt.where(FollowUpTask.level == level)
    rows = db.execute(stmt).all()
    return [
        {**ser.task_out(t, user), "patient": ser.patient_brief(p, user)}
        for t, p in rows
    ]


@router.get("/reports")
def list_reports(patient_id: int | None = None,
                 user: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    stmt = select(Report, Patient).join(Patient, Patient.id == Report.patient_id)
    if patient_id:
        stmt = stmt.where(Report.patient_id == patient_id)
    stmt = stmt.order_by(Report.event_time.desc())
    out = []
    for r, p in db.execute(stmt).all():
        images = db.scalars(
            select(ReportImage).where(ReportImage.report_id == r.id)
        ).all()
        r.images = images
        item = ser.report_out(r, user, p)
        item["patient"] = ser.patient_brief(p, user)
        out.append(item)
    return out


@router.get("/escalations")
def list_escalations(active_only: bool = True,
                     user: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    stmt = select(Escalation, Patient).join(
        Patient, Patient.id == Escalation.patient_id
    ).order_by(Escalation.opened_at.desc())
    if active_only:
        stmt = stmt.where(
            Escalation.status.in_(
                ["open", "phone_followup", "ed_advised",
                 "referral_requested", "referral_confirmed"]
            )
        )
    out = []
    for e, p in db.execute(stmt).all():
        item = ser.escalation_out(e, user, p)
        refs = db.scalars(
            select(Referral).where(Referral.escalation_id == e.id)
        ).all()
        item["referrals"] = []
        for ref in refs:
            requester = db.get(Staff, ref.requested_by_id)
            item["referrals"].append(ser.referral_out(ref, user, requester.name if requester else ""))
        out.append(item)
    return out


@router.get("/escalations/{esc_id}")
def escalation_detail(esc_id: int, user: CurrentUser = Depends(current_user),
                      db: Session = Depends(get_db)):
    e = db.get(Escalation, esc_id)
    if e is None:
        raise HTTPException(404, "升级单不存在")
    p = db.get(Patient, e.patient_id)
    out = ser.escalation_out(e, user, p)

    reports = db.scalars(
        select(Report).where(Report.escalation_id == e.id).order_by(Report.event_time)
    ).all()
    report_list = []
    for r in reports:
        r.images = db.scalars(
            select(ReportImage).where(ReportImage.report_id == r.id)
        ).all()
        report_list.append(ser.report_out(r, user, p))
    out["reports"] = report_list

    actions = []
    for a in db.scalars(
        select(TriageAction).where(TriageAction.escalation_id == e.id)
        .order_by(TriageAction.event_time)
    ).all():
        nurse = db.get(Staff, a.nurse_id)
        actions.append(ser.triage_out(a, nurse.name if nurse else ""))
    out["triage_actions"] = actions

    callbacks = []
    for c in db.scalars(
        select(Callback).where(Callback.escalation_id == e.id)
        .order_by(Callback.event_time)
    ).all():
        nurse = db.get(Staff, c.nurse_id)
        callbacks.append(ser.callback_out(c, nurse.name if nurse else ""))
    out["callbacks"] = callbacks

    orders = []
    for o in db.scalars(
        select(Order).where(Order.escalation_id == e.id).order_by(Order.event_time)
    ).all():
        doc = db.get(Staff, o.doctor_id)
        oo = ser.order_out(o, user, doc.name if doc else "")
        if oo:
            orders.append(oo)
    out["orders"] = orders

    reviews = []
    for rv in db.scalars(
        select(PharmacyReview).where(PharmacyReview.escalation_id == e.id)
        .order_by(PharmacyReview.event_time)
    ).all():
        ph = db.get(Staff, rv.pharmacist_id)
        reviews.append(ser.review_out(rv, ph.name if ph else ""))
    out["pharmacy_reviews"] = reviews

    refs = []
    for ref in db.scalars(
        select(Referral).where(Referral.escalation_id == e.id)
        .order_by(Referral.request_event_time)
    ).all():
        requester = db.get(Staff, ref.requested_by_id)
        refs.append(ser.referral_out(ref, user, requester.name if requester else ""))
    out["referrals"] = refs
    return out


@router.get("/patients/{pid}/timeline")
def patient_timeline(pid: int, user: CurrentUser = Depends(current_user),
                     db: Session = Depends(get_db)):
    p = db.get(Patient, pid)
    if p is None:
        raise HTTPException(404, "患者不存在")
    # 患者只能看自己的时间线（patient 角色的 user.id == pid 才放行）
    if user.is_patient and user.id != pid:
        raise HTTPException(403, "只能查看本人的时间线")
    events = db.scalars(
        select(Event).where(Event.patient_id == pid)
        .order_by(Event.event_time, Event.recorded_at, Event.id)
    ).all()
    out = []
    for ev in events:
        eo = ser.event_out(ev, user)
        if eo is not None:
            out.append(eo)
    return {"patient": ser.patient_brief(p, user), "events": out,
            "note": "时间线以业务发生时间 event_time 排序；recorded_at 为系统录入时间，补录动作不改变排序事实。"}


@router.get("/images/{image_id}")
def read_image(image_id: int, user: CurrentUser = Depends(current_user),
               db: Session = Depends(get_db)):
    if user.is_patient:
        raise HTTPException(403, "患者入口不提供原图读取")
    if user.role == "pharmacist":
        # 药师不可见上报图片（脱敏硬边界）
        raise HTTPException(403, "药师角色无权查看患者图片")
    img = db.get(ReportImage, image_id)
    if img is None or img.status != "ok" or not img.stored_path:
        raise HTTPException(404, "图片不存在或不可读")
    if not os.path.exists(img.stored_path):
        raise HTTPException(410, "图片文件缺失")
    return FileResponse(img.stored_path, media_type=img.content_type)
