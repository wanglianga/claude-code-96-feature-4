// ============ 领域类型定义 ============

export type Role = 'patient' | 'nurse' | 'doctor' | 'pharmacist';

export type Channel = 'mini_app' | 'sms' | 'hotline'; // 小程序 / 短信 / 电话热线

export type RiskLevel = 'low' | 'medium' | 'high';

export type TriageLevel = 'L1' | 'L2' | 'L3'; // 一级(低) / 二级(中) / 三级(高)

export type TaskType =
  | 'routine_followup' // 常规自动随访
  | 'escalation' // 升级任务（高风险）
  | 'manual_queue'; // 人工队列任务

export type TaskStatus =
  | 'scheduled' // 已排期（常规任务）
  | 'frozen' // 已冻结（高风险触发后普通自动随访冻结）
  | 'open' // 待处理（升级/人工队列）
  | 'in_progress' // 处理中
  | 'done' // 已完成
  | 'cancelled' // 已取消（被替代/被撤回等）
  ;

export type ReferralStatus = 'requested' | 'confirmed' | 'rejected' | 'cancelled';

export type OrderStatus = 'active' | 'withdrawn';

// ---- 事件（只追加，永不修改/删除）----
export type EventType =
  // 患者域
  | 'patient_reported' // 患者上报（含判重命中时仍保留原始记录，标记 duplicate_of）
  | 'consent_declined' // 患者拒绝联系
  | 'consent_expired' // 授权过期（系统检测）
  | 'image_unreadable' // 图片无法读取（系统/人工标记）
  // 分诊域
  | 'risk_escalated' // 命中高风险规则 → 冻结普通随访 + 创建升级任务
  | 'manual_queued' // 转入人工队列（拒绝联系/授权过期/图片无法读取/中风险复核等）
  | 'nurse_screened' // 护士初筛：phone_callback / er_advice / referral_request
  | 'phone_logged' // 电话回访记录
  | 'er_advised' // 急诊建议
  | 'referral_requested' // 转诊申请（去重：同一升级事件仅允许一个有效转诊）
  | 'referral_confirmed' // 转诊确认
  | 'referral_rejected' // 转诊驳回
  // 医嘱域
  | 'order_added' // 医生补充医嘱（可能与既有随访计划冲突 → 计划被替代）
  | 'order_withdrawn' // 医生撤回错误医嘱（不覆盖原始记录）
  | 'plan_superseded' // 旧随访任务被新计划/新医嘱替代取消
  // 药师域
  | 'pharmacy_review' // 药师：相互作用/用药建议（不可改诊疗结论）
  // 任务/关闭域
  | 'task_created' // 任务创建（常规/升级/人工队列均通过此事件）
  | 'task_status_changed' // 任务状态流转（完成/取消/解冻）
  | 'case_closed' // 事件闭环关闭（含关闭依据）
  | 'case_reopened' // 关闭后再次上报恶化 → 重开
  // 系统域
  | 'followup_plan_generated' // 系统按分级规则生成常规随访计划
  | 'sla_reminder' // 高风险超时未闭环提醒
  | 'notification_sent' // 异步通知发送结果（outbox）
  | 'note_added'; // 人工队列处理备注

export interface BaseEvent {
  id: string;
  type: EventType;
  patientId: string;
  taskId?: string;
  /** 业务发生时间（ISO 字符串）。补录时可早于记录时间，时间线一律按此排序 */
  occurredAt: string;
  /** 系统记录时间（写入时刻，永不改变，用于审计“先记录后补录”） */
  recordedAt: string;
  actorId: string; // 触发者（用户 id 或 'system'）
  actorRole: Role | 'system';
  /** 命令幂等键：同一 clientMsgId 的写命令只生效一次 */
  commandId?: string;
  /** 乐观并发版本：该事件写入后聚合的版本号 */
  version: number;
  payload: Record<string, unknown>;
}

// ---- 实体（由事件投影得到）----
export interface Allergy {
  drug: string;
  reaction: string;
}

export interface MedPlanItem {
  id: string;
  drug: string;
  dose: string;
  frequency: string;
  startDay: number; // 出院后第几天开始
  endDay: number;
}

export interface Patient {
  id: string;
  name: string;
  gender: '男' | '女';
  age: number;
  phone: string;
  idCardLast4: string;
  surgeryType: string;
  dischargeDate: string; // 出院日期
  dischargeOrders: string[]; // 出院医嘱摘要
  allergies: Allergy[]; // 过敏史
  medPlan: MedPlanItem[]; // 用药计划
  /** 数据授权（受限入口查看/联系授权） */
  consent: {
    validUntil: string; // 授权到期时间
    declinedContact: boolean; // 是否拒绝联系
  };
}

export interface Report {
  id: string;
  eventId: string;
  patientId: string;
  channel: Channel;
  occurredAt: string;
  recordedAt: string;
  symptoms: string[];
  temperature?: number;
  systolic?: number;
  diastolic?: number;
  adherence: 'full' | 'partial' | 'none' | 'unknown';
  imageIds: string[];
  imageReadable: boolean;
  note?: string;
  risk: RiskLevel;
  triggeredRules: string[];
  duplicateOf?: string; // 判重：内容指纹相同的上一条上报 id
  escalationId?: string; // 触发的升级任务
  handled: boolean;
}

export interface FollowUpTask {
  id: string;
  patientId: string;
  type: TaskType;
  title: string;
  level?: TriageLevel;
  status: TaskStatus;
  dueAt: string; // 时限
  scheduledDay?: number; // 出院后第几天（常规任务）
  createdAt: string;
  closedAt?: string;
  /** 取代关系：本任务被哪个事件/任务取消或替代 */
  supersededBy?: { eventId: string; reason: string; newTaskId?: string };
  /** 本任务是哪个旧任务的替代（替代/恢复关系正向指针） */
  replacesTaskId?: string;
  /** 升级任务关联的首报 */
  sourceReportId?: string;
  /** 人工队列原因 */
  queueReason?: string;
}

export interface Order {
  id: string;
  eventId: string; // 原始追加事件
  patientId: string;
  content: string;
  status: OrderStatus;
  orderedAt: string; // 医嘱业务时间（可补录）
  recordedAt: string;
  withdrawnByEventId?: string;
  withdrawReason?: string;
  backdated: boolean; // 是否补录（业务时间早于同任务已有记录）
}

export interface PharmacyAdvice {
  id: string;
  eventId: string;
  patientId: string;
  taskId?: string;
  interaction: string; // 相互作用说明
  advice: string; // 用药建议
  severity: 'info' | 'warning' | 'critical';
  createdAt: string;
}

export interface Referral {
  id: string;
  taskId: string;
  patientId: string;
  reason: string;
  targetDept: string;
  status: ReferralStatus;
  requestedAt: string;
  confirmedAt?: string;
  rejectedAt?: string;
  rejectReason?: string;
  /** 转诊未确认期间再次上报：以备注形式挂接，不允许创建第二张转诊单 */
  pendingNotes: { at: string; reportId: string; text: string }[];
}

export interface Closure {
  taskId: string;
  eventId: string;
  basis: string; // 关闭依据
  closedAt: string;
}

export interface SlaReminder {
  eventId: string;
  taskId: string;
  at: string;
  count: number; // 第几次提醒
}

export interface NotificationRecord {
  eventId: string;
  channel: 'sms' | 'app_push';
  target: string;
  purpose: string;
  status: 'success' | 'failed';
  at: string;
  failReason?: string;
}

/** 聚合投影：一个患者的完整状态 */
export interface PatientAggregate {
  patient: Patient;
  reports: Report[];
  tasks: FollowUpTask[];
  orders: Order[];
  advices: PharmacyAdvice[];
  referrals: Referral[];
  closures: Closure[];
  reminders: SlaReminder[];
  notifications: NotificationRecord[];
  version: number;
}

export interface User {
  id: string;
  login: string;
  password: string;
  name: string;
  role: Role;
  patientId?: string; // 患者角色绑定的档案
}
