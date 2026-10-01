"""患者上报：幂等提交、跨入口去重、高风险判定 → 冻结普通随访 + 创建升级单。

并发安全：
- (patient_id, idempotency_key) 唯一约束兜底重复提交；
- escalations.active_guard 唯一约束保证每患者至多一个活跃升级（并发上报不重复升级）；
- 重复内容（不同入口）只合并，不再触发规则。
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Escalation,
    FollowUpTask,
    Patient,
    Report,
    ReportImage,
    Staff,
)
from ..rules import evaluate_risk
from ..events import record_event
from . import notifications as notify
from . import queue as manual_queue


def _signature(payload: dict) -> str:
    raw = "|".join(
        [
            ",".join(sorted(payload.get("symptoms", []))),
            str(round(float(payload.get("temperature") or 0), 1)),
            str(payload.get("systolic") or 0),
            str(payload.get("diastolic") or 0),
            str(payload.get("adherence") or "unknown"),
            (payload.get("symptom_text") or "").strip()[:80],
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def consent_valid(patient: Patient, now: datetime) -> bool:
    return patient.consent_until is not None and patient.consent_until > now


def _find_duplicate(db: Session, patient_id: int, bucket: str, event_time: datetime):
    window = timedelta(seconds=settings.DEDUP_WINDOW_SECONDS)
    rows = db.scalars(
        select(Report).where(
            Report.patient_id == patient_id,
            Report.dedup_bucket == bucket,
            Report.status != "merged",
            Report.duplicate_of_id.is_(None),
            Report.event_time.between(event_time - window, event_time + window),
        )
    ).all()
    return rows[0] if rows else None


def _notify_nurses(db: Session, patient: Patient, title: str, body: str):
    nurses = db.scalars(select(Staff).where(Staff.role == "nurse", Staff.active.is_(True))).all()
    for n in nurses:
        notify.enqueue(
            db,
            ntype="escalation",
            title=title,
            body=body,
            target_staff_id=n.id,
            channel="im",
            patient_id=patient.id,
        )


def _freeze_open_tasks(db: Session, patient: Patient, escalation: Escalation) -> list[int]:
    tasks = db.scalars(
        select(FollowUpTask).where(
            FollowUpTask.patient_id == patient.id,
            FollowUpTask.kind == "auto",
            FollowUpTask.status.in_(["scheduled", "in_progress"]),
        )
    ).all()
    ids = []
    for t in tasks:
        t.status = "frozen"
        t.escalation_id = escalation.id
        ids.append(t.id)
        record_event(
            db,
            patient_id=patient.id,
            aggregate="task",
            aggregate_id=t.id,
            event_type="task.frozen",
            summary=f"高风险升级单 #{escalation.id} 开启，普通自动随访任务冻结：{t.title}",
            data={"escalation_id": escalation.id},
        )
    return ids


def _create_or_attach_escalation(
    db: Session, patient: Patient, report: Report, hits: list[dict], now: datetime
) -> tuple[Escalation, bool]:
    """返回 (升级单, 是否新建)。并发下若已有活跃升级则挂接到既有单。"""
    existing = db.scalar(
        select(Escalation).where(
            Escalation.patient_id == patient.id,
            Escalation.status.notin_(["closed", "cancelled"]),
        )
    )
    if existing is not None:
        return existing, False

    esc = Escalation(
        patient_id=patient.id,
        trigger_report_id=report.id,
        risk_hits=hits,
        risk_summary="；".join(h["label"] + (str(h.get("value") or "")) for h in hits),
        status="open",
        opened_at=now,
        sla_due_at=now + timedelta(minutes=settings.SLA_MINUTES_HIGH),
        active_guard=f"patient:{patient.id}",
    )
    # SAVEPOINT：并发下另一个请求已建活跃升级时，只回滚本保存点，
    # 保留外层事务中已写入的上报与事件。
    try:
        with db.begin_nested():
            db.add(esc)
            db.flush()
    except IntegrityError:
        existing = db.scalar(
            select(Escalation).where(
                Escalation.patient_id == patient.id,
                Escalation.status.notin_(["closed", "cancelled"]),
            )
        )
        if existing is None:
            # 并发赢家尚未提交（极端情况）：上报转人工兜底，避免高风险无人接管
            manual_queue.enqueue_manual(
                db, patient_id=patient.id, report_id=report.id,
                reason_type="other",
                detail="并发升级冲突，升级单归属待人工确认（高风险症状："
                       + "；".join(x["label"] for x in hits) + "）",
            )
            report.status = "held"
            return None, False
        report.escalation_id = existing.id
        return existing, False

    frozen = _freeze_open_tasks(db, patient, esc)
    esc.frozen_task_ids = frozen
    report.escalation_id = esc.id
    report.status = "triaged"

    record_event(
        db,
        patient_id=patient.id,
        aggregate="escalation",
        aggregate_id=esc.id,
        event_type="escalation.opened",
        event_time=report.event_time,
        summary=(
            f"上报触发高风险规则（{'；'.join(h['label'] for h in hits)}），"
            f"自动创建升级任务 #{esc.id}，冻结 {len(frozen)} 个普通随访任务，"
            f"SLA 截止 {esc.sla_due_at:%Y-%m-%d %H:%M}"
        ),
        data={"risk_hits": hits, "frozen_task_ids": frozen,
              "sla_due_at": esc.sla_due_at.isoformat()},
    )
    return esc, True


def submit_report(db: Session, patient: Patient, payload: dict) -> dict:
    now = datetime.utcnow()
    event_time = payload.get("event_time") or now
    if isinstance(event_time, str):
        event_time = datetime.fromisoformat(event_time)

    # 1) 幂等键：重放直接返回原单
    idem_key = (payload.get("idempotency_key") or "").strip()
    if idem_key:
        existing = db.scalar(
            select(Report).where(
                Report.patient_id == patient.id, Report.idempotency_key == idem_key
            )
        )
        if existing:
            return {"report": existing, "created": False, "duplicate": False,
                    "escalation": db.get(Escalation, existing.escalation_id)
                    if existing.escalation_id else None}

    symptoms = payload.get("symptoms") or []
    symptom_text = payload.get("symptom_text") or ""
    temperature = payload.get("temperature")
    systolic = payload.get("systolic")
    diastolic = payload.get("diastolic")
    adherence = payload.get("adherence") or "unknown"
    channel = payload.get("channel") or "portal"
    contact_ok = bool(payload.get("contact_ok", True))
    image_ids = payload.get("image_ids") or []

    bucket = _signature(
        {"symptoms": symptoms, "symptom_text": symptom_text, "temperature": temperature,
         "systolic": systolic, "diastolic": diastolic, "adherence": adherence}
    )

    # 2) 跨入口时间窗去重
    dup = _find_duplicate(db, patient.id, bucket, event_time)
    if dup is not None:
        merged = Report(
            patient_id=patient.id,
            idempotency_key=idem_key or f"merged-{bucket}-{int(event_time.timestamp())}",
            dedup_bucket=bucket,
            duplicate_of_id=dup.id,
            channel=channel,
            symptoms=symptoms,
            symptom_text=symptom_text,
            temperature=temperature,
            systolic=systolic,
            diastolic=diastolic,
            adherence=adherence,
            contact_ok=contact_ok,
            high_risk=False,
            status="merged",
            event_time=event_time,
        )
        db.add(merged)
        db.flush()
        _link_images(db, image_ids, merged.id, patient)
        record_event(
            db,
            patient_id=patient.id,
            aggregate="report",
            aggregate_id=merged.id,
            event_type="report.merged",
            event_time=event_time,
            actor_type="patient",
            actor_id=patient.id,
            actor_name=patient.name,
            summary=f"患者经 {channel} 重复上报，与上报 #{dup.id} 内容一致，已合并（不重复分诊）",
            data={"duplicate_of": dup.id, "channel": channel},
        )
        db.commit()
        return {"report": merged, "created": True, "duplicate": True,
                "escalation": db.get(Escalation, dup.escalation_id)
                if dup.escalation_id else None}

    # 3) 落新上报
    hits = evaluate_risk(symptoms, symptom_text, temperature, systolic, diastolic,
                         patient.allergy)
    report = Report(
        patient_id=patient.id,
        idempotency_key=idem_key or f"auto-{bucket}-{int(event_time.timestamp()*1000)}",
        dedup_bucket=bucket,
        channel=channel,
        symptoms=symptoms,
        symptom_text=symptom_text,
        temperature=temperature,
        systolic=systolic,
        diastolic=diastolic,
        adherence=adherence,
        contact_ok=contact_ok,
        high_risk=bool(hits),
        risk_hits=hits,
        status="new",
        event_time=event_time,
    )
    db.add(report)
    try:
        db.flush()
    except IntegrityError:
        # 并发提交同一幂等键
        db.rollback()
        existing = db.scalar(
            select(Report).where(
                Report.patient_id == patient.id, Report.idempotency_key == idem_key
            )
        )
        return {"report": existing, "created": False, "duplicate": False,
                "escalation": db.get(Escalation, existing.escalation_id)
                if existing.escalation_id else None}

    unreadable = _link_images(db, image_ids, report.id, patient)
    record_event(
        db,
        patient_id=patient.id,
        aggregate="report",
        aggregate_id=report.id,
        event_type="report.submitted",
        event_time=event_time,
        actor_type="patient",
        actor_id=patient.id,
        actor_name=patient.name,
        summary=f"患者经 {channel} 上报：{_brief(report)}",
        data={"channel": channel, "high_risk": bool(hits), "risk_hits": hits,
              "images": len(image_ids), "unreadable_images": len(unreadable)},
    )
    for img in unreadable:
        manual_queue.enqueue_manual(
            db,
            patient_id=patient.id,
            reason_type="image_unreadable",
            detail=f"上报 #{report.id} 附件“{img.filename}”无法读取：{img.unreadable_reason}",
            report_id=report.id,
        )

    # 4) 联系意愿 / 授权异常 → 人工队列（无论是否高风险都留痕；高风险仍升级，由人工按合规方式处置）
    if not contact_ok or patient.contact_refused:
        manual_queue.enqueue_manual(
            db, patient_id=patient.id, reason_type="contact_refused",
            detail=f"患者在上报 #{report.id} 中表示拒绝电话联系",
            report_id=report.id,
        )
    if not consent_valid(patient, now):
        manual_queue.enqueue_manual(
            db, patient_id=patient.id, reason_type="consent_expired",
            detail=f"随访授权已于 {patient.consent_until} 过期，需先续授权",
            report_id=report.id,
        )

    escalation = None
    if hits:
        escalation, created = _create_or_attach_escalation(db, patient, report, hits, now)
        if escalation is None:
            # 并发赢家尚未提交：已转人工兜底，不做后续挂接
            pass
        elif created:
            _notify_nurses(
                db, patient,
                f"【高风险】{patient.name} 触发{ '、'.join(h['label'] for h in hits) }",
                f"升级单 #{escalation.id} 已创建，请在 {settings.SLA_MINUTES_HIGH} 分钟内完成初筛",
            )
        elif not created:
            # 已有活跃升级（可能转诊尚未确认）→ 挂接并紧急提醒，不重复升级/转诊
            report.escalation_id = escalation.id
            report.status = "triaged"
            worsening = "referral" in escalation.status or escalation.status in (
                "referral_requested",
            )
            tag = "转诊尚未确认期间患者再次上报恶化" if worsening else "升级处置期间再次上报"
            record_event(
                db,
                patient_id=patient.id,
                aggregate="escalation",
                aggregate_id=escalation.id,
                event_type="escalation.worsening",
                event_time=event_time,
                actor_type="patient",
                actor_id=patient.id,
                actor_name=patient.name,
                summary=f"{tag}：{_brief(report)}（挂接至升级单 #{escalation.id}，不另建转诊）",
                data={"report_id": report.id, "risk_hits": hits,
                      "esc_status": escalation.status},
            )
            _notify_nurses(
                db, patient,
                f"【再次上报】{patient.name} {tag}",
                f"升级单 #{escalation.id}：{'；'.join(h['label'] for h in hits)}",
            )

    db.commit()
    return {"report": report, "created": True, "duplicate": False,
            "escalation": escalation}


def _link_images(db: Session, image_ids: list[int], report_id: int,
                 patient: Patient) -> list[ReportImage]:
    unreadable = []
    for iid in image_ids:
        img = db.get(ReportImage, iid)
        if img is None or img.report_id is not None:
            continue
        img.report_id = report_id
        if img.status == "unreadable":
            unreadable.append(img)
    return unreadable


def _brief(report: Report) -> str:
    parts = []
    if report.symptoms:
        parts.append("、".join(report.symptoms))
    if report.temperature:
        parts.append(f"T {report.temperature}℃")
    if report.systolic:
        parts.append(f"BP {report.systolic}/{report.diastolic}")
    if report.symptom_text:
        parts.append(report.symptom_text[:30])
    return "，".join(parts) or "无明显症状（仅提交体征/用药情况）"
