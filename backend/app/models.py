"""领域模型。

设计要点：
- 所有状态变更都同时写入 events（append-only，不可改不可删），时间线以 events 为准。
- event_time  = 业务发生时间（可补录、可早于他人记录）；
  recorded_at = 服务器落库时间（单调，仅用于审计“何时录入”）。
- 业务表上的状态字段只是事件在当前时刻的折叠快照；撤回/改写只追加“反转事件”+
  更新快照，绝不 UPDATE/DELETE 原始记录文本。
- 关键唯一性用数据库约束兜底，保证角色并发操作下不重复转诊/不重复升级。
所有时间统一存“朴素 UTC”。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.utcnow()


# MariaDB 用 BIGINT，SQLite 自增主键仅支持 INTEGER（测试库兼容）
BigIntPK = BigInteger().with_variant(Integer, "sqlite")


# ---------------- 身份与权限 ----------------

class Patient(Base):
    __tablename__ = "patients"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)  # 病案号
    name: Mapped[str] = mapped_column(String(64))
    gender: Mapped[str] = mapped_column(String(8))
    birth_date: Mapped[str] = mapped_column(String(10))
    phone: Mapped[str] = mapped_column(String(32))
    id_card_tail: Mapped[str] = mapped_column(String(4))  # 受限入口校验用（身份证后4位）

    # 出院信息
    department: Mapped[str] = mapped_column(String(64))
    surgery_type: Mapped[str] = mapped_column(String(128))
    surgery_date: Mapped[str] = mapped_column(String(10))
    discharge_date: Mapped[str] = mapped_column(String(10))
    discharge_orders: Mapped[str] = mapped_column(Text, default="")
    allergy: Mapped[str] = mapped_column(Text, default="")  # 过敏史（敏感）

    # 随访授权与联系意愿
    consent_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    contact_refused: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Staff(Base):
    __tablename__ = "staff"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(16))  # nurse / doctor / pharmacist / admin
    department: Mapped[str] = mapped_column(String(64), default="")
    password_hash: Mapped[str] = mapped_column(String(128), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # 演示用：部分员工的通知通道被置为“会失败”，用于演示异步通知失败重试
    notify_failing: Mapped[bool] = mapped_column(Boolean, default=False)


# ---------------- 用药计划 ----------------

class MedicationPlan(Base):
    __tablename__ = "medication_plans"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    drug_name: Mapped[str] = mapped_column(String(128))
    dosage: Mapped[str] = mapped_column(String(64))
    frequency: Mapped[str] = mapped_column(String(64))
    start_date: Mapped[str] = mapped_column(String(10))
    end_date: Mapped[str] = mapped_column(String(10))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


# ---------------- 随访任务（分级自动随访 / 升级 / 人工） ----------------

class FollowUpTask(Base):
    __tablename__ = "followup_tasks"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    level: Mapped[str] = mapped_column(String(8))  # L1 / L2 / L3 / ESC / MANUAL
    kind: Mapped[str] = mapped_column(String(16))  # auto / escalation / manual
    status: Mapped[str] = mapped_column(String(16), default="scheduled", index=True)
    # scheduled → in_progress → completed
    # scheduled/in_progress → frozen → (resumed) / cancelled(superseded)
    title: Mapped[str] = mapped_column(String(200))
    reason: Mapped[str] = mapped_column(Text, default="")
    due_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    assignee_role: Mapped[str] = mapped_column(String(16), default="nurse")

    # 取消 / 替代关系（旧任务未完成时必须留痕）
    cancel_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    superseded_by_task_id: Mapped[int | None] = mapped_column(
        ForeignKey("followup_tasks.id"), nullable=True
    )
    superseded_by_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id"), nullable=True
    )
    escalation_id: Mapped[int | None] = mapped_column(
        ForeignKey("escalations.id"), nullable=True
    )
    closure_basis: Mapped[str | None] = mapped_column(Text, nullable=True)

    version: Mapped[int] = mapped_column(Integer, default=1)  # 乐观锁
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_tasks_patient_status", "patient_id", "status"),
    )


# ---------------- 患者上报 ----------------

class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)

    # 幂等：同一患者用同一键重放（双击/重试/跨入口）直接返回原记录
    idempotency_key: Mapped[str] = mapped_column(String(80))
    # 去重桶：同内容签名 + 时间窗，跨入口（portal/mini/sms）归一
    dedup_bucket: Mapped[str] = mapped_column(String(64), index=True)
    duplicate_of_id: Mapped[int | None] = mapped_column(
        ForeignKey("reports.id"), nullable=True
    )

    channel: Mapped[str] = mapped_column(String(16))  # portal / mini_app / sms
    symptoms: Mapped[list] = mapped_column(JSON, default=list)
    symptom_text: Mapped[str] = mapped_column(Text, default="")
    temperature: Mapped[float | None] = mapped_column(Float, nullable=True)
    systolic: Mapped[int | None] = mapped_column(Integer, nullable=True)
    diastolic: Mapped[int | None] = mapped_column(Integer, nullable=True)
    adherence: Mapped[str] = mapped_column(String(16), default="unknown")
    # full / partial / none / unknown
    contact_ok: Mapped[bool] = mapped_column(Boolean, default=True)

    high_risk: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    risk_hits: Mapped[list] = mapped_column(JSON, default=list)

    status: Mapped[str] = mapped_column(String(16), default="new")
    # new / merged / triaged / held（授权过期等原因挂起转人工）
    escalation_id: Mapped[int | None] = mapped_column(
        ForeignKey("escalations.id"), nullable=True
    )

    event_time: Mapped[datetime] = mapped_column(DateTime, index=True)  # 症状发生时间
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    __table_args__ = (
        UniqueConstraint("patient_id", "idempotency_key", name="uq_report_idem"),
    )


class ReportImage(Base):
    __tablename__ = "report_images"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    # 上传时先落库（report_id 为空），上报提交后回填
    report_id: Mapped[int | None] = mapped_column(
        ForeignKey("reports.id"), nullable=True, index=True
    )
    filename: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    sha256: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="pending")
    # pending / ok / unreadable
    unreadable_reason: Mapped[str] = mapped_column(String(200), default="")
    stored_path: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ---------------- 升级单（高风险事件） ----------------

class Escalation(Base):
    __tablename__ = "escalations"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    trigger_report_id: Mapped[int | None] = mapped_column(
        ForeignKey("reports.id"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(24), default="open", index=True)
    # open / phone_followup / ed_advised / referral_requested / referral_confirmed / closed
    risk_hits: Mapped[list] = mapped_column(JSON, default=list)
    risk_summary: Mapped[str] = mapped_column(Text, default="")

    frozen_task_ids: Mapped[list] = mapped_column(JSON, default=list)

    opened_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    sla_due_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    reminder_count: Mapped[int] = mapped_column(Integer, default=0)
    last_reminder_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    queued_manual: Mapped[bool] = mapped_column(Boolean, default=False)

    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_by_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    closure_basis: Mapped[str | None] = mapped_column(Text, nullable=True)

    # 唯一活跃升级守卫：活跃时为 f"patient:{id}"，关闭后置 NULL。
    # MariaDB / SQLite 的 UNIQUE 都允许多个 NULL，故用它实现“每患者至多一个活跃升级”。
    active_guard: Mapped[str | None] = mapped_column(
        String(40), unique=True, nullable=True
    )

    reports: Mapped[list["Report"]] = relationship(foreign_keys="Report.escalation_id")


# ---------------- 护士初筛 / 电话回访 ----------------

class TriageAction(Base):
    __tablename__ = "triage_actions"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    escalation_id: Mapped[int] = mapped_column(ForeignKey("escalations.id"), index=True)
    nurse_id: Mapped[int] = mapped_column(ForeignKey("staff.id"))
    action: Mapped[str] = mapped_column(String(24))
    # phone_callback / ed_advice / referral_request / note
    note: Mapped[str] = mapped_column(Text, default="")
    event_time: Mapped[datetime] = mapped_column(DateTime, index=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Callback(Base):
    __tablename__ = "callbacks"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    escalation_id: Mapped[int] = mapped_column(ForeignKey("escalations.id"), index=True)
    nurse_id: Mapped[int] = mapped_column(ForeignKey("staff.id"))
    reached: Mapped[bool] = mapped_column(Boolean, default=False)
    outcome: Mapped[str] = mapped_column(String(200), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    event_time: Mapped[datetime] = mapped_column(DateTime)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ---------------- 转诊 ----------------

class Referral(Base):
    __tablename__ = "referrals"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    escalation_id: Mapped[int] = mapped_column(ForeignKey("escalations.id"), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"))
    target: Mapped[str] = mapped_column(String(128))
    reason: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="requested")
    # requested / confirmed / rejected / cancelled

    requested_by_id: Mapped[int] = mapped_column(ForeignKey("staff.id"))
    request_event_time: Mapped[datetime] = mapped_column(DateTime)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    confirmation_note: Mapped[str] = mapped_column(Text, default="")

    # 幂等守卫：同一升级单存在“进行中”的转诊时 = f"esc:{escalation_id}"，
    # 终态（rejected/cancelled）后置 NULL，允许重新申请。并发插入由数据库拒绝重复。
    active_guard: Mapped[str | None] = mapped_column(
        String(40), unique=True, nullable=True
    )


# ---------------- 医嘱（可撤回，不可删改） ----------------

class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    escalation_id: Mapped[int | None] = mapped_column(
        ForeignKey("escalations.id"), nullable=True, index=True
    )
    doctor_id: Mapped[int] = mapped_column(ForeignKey("staff.id"))
    order_type: Mapped[str] = mapped_column(String(24))
    # follow_adjust / medication / exam / other
    content: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    # active / withdrawn

    event_time: Mapped[datetime] = mapped_column(DateTime, index=True)  # 可补录
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    withdraw_reason: Mapped[str] = mapped_column(Text, default="")
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)

    # 该医嘱是否需要药师审方（用药类）
    pharmacy_status: Mapped[str] = mapped_column(String(16), default="not_required")
    # not_required / pending / reviewed / interaction_flag


# ---------------- 药师审方（只能涉及用药） ----------------

class PharmacyReview(Base):
    __tablename__ = "pharmacy_reviews"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    escalation_id: Mapped[int | None] = mapped_column(
        ForeignKey("escalations.id"), nullable=True
    )
    pharmacist_id: Mapped[int] = mapped_column(ForeignKey("staff.id"))
    interaction_found: Mapped[bool] = mapped_column(Boolean, default=False)
    interaction_detail: Mapped[str] = mapped_column(Text, default="")
    advice: Mapped[str] = mapped_column(Text, default="")
    event_time: Mapped[datetime] = mapped_column(DateTime)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ---------------- 人工队列 ----------------

class ManualQueueItem(Base):
    __tablename__ = "manual_queue"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    escalation_id: Mapped[int | None] = mapped_column(
        ForeignKey("escalations.id"), nullable=True
    )
    report_id: Mapped[int | None] = mapped_column(
        ForeignKey("reports.id"), nullable=True
    )
    reason_type: Mapped[str] = mapped_column(String(24), index=True)
    # contact_refused / consent_expired / image_unreadable / sla_breach / other
    detail: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    # open / claimed / resolved

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    claimed_by_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    resolved_by_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    resolution: Mapped[str] = mapped_column(Text, default="")
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


# ---------------- 异步通知 outbox ----------------

class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    channel: Mapped[str] = mapped_column(String(16))  # sms / im / email
    patient_id: Mapped[int | None] = mapped_column(
        ForeignKey("patients.id"), nullable=True, index=True
    )
    target_staff_id: Mapped[int | None] = mapped_column(
        ForeignKey("staff.id"), nullable=True
    )
    target_phone: Mapped[str] = mapped_column(String(32), default="")
    ntype: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")

    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)
    # pending / sent / failed / dead
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, index=True
    )
    last_error: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ---------------- 统一事件时间线 ----------------

class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    aggregate: Mapped[str] = mapped_column(String(32), index=True)
    # escalation / task / order / referral / report / pharmacy / queue / notification
    aggregate_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    event_type: Mapped[str] = mapped_column(String(48), index=True)
    actor_type: Mapped[str] = mapped_column(String(16))  # patient/staff/system
    actor_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    actor_name: Mapped[str] = mapped_column(String(64), default="系统")

    summary: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict] = mapped_column(JSON, default=dict)

    event_time: Mapped[datetime] = mapped_column(DateTime, index=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    __table_args__ = (
        Index("ix_events_patient_time", "patient_id", "event_time"),
        Index("ix_events_agg", "aggregate", "aggregate_id"),
    )
