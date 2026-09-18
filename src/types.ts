// ---------- 角色与账号 ----------
export type Role = 'nurse' | 'anesthetist' | 'cashier' | 'family'

export interface Account {
  account: string
  password: string
  name: string
  role: Role
  title: string
  patientId?: string // 家属账号绑定的患者
}

export interface SessionUser {
  account: string
  name: string
  role: Role
  title: string
  patientId?: string
}

// ---------- 患者状态机 ----------
export type PatientStatus =
  | 'booked' // 已预约待签到
  | 'registered' // 已签到（待术前评估）
  | 'waiting' // 候诊中（评估完成）
  | 'in_or' // 已入室
  | 'in_surgery' // 手术中
  | 'recovery' // 复苏观察
  | 'ready_pickup' // 待接走
  | 'discharged' // 已离院

export const STATUS_FLOW: PatientStatus[] = [
  'booked',
  'registered',
  'waiting',
  'in_or',
  'in_surgery',
  'recovery',
  'ready_pickup',
  'discharged',
]

// ---------- 业务实体 ----------
export interface ExamItem {
  name: string
  done: boolean
}

export interface Payment {
  total: number
  paid: number
}

export interface Person {
  name: string
  phone: string
  relation: string
}

export interface PreopAssessment {
  sbp: number // 收缩压
  dbp: number // 舒张压
  hr: number // 心率
  spo2: number // 血氧
  temp: number // 体温
  skinTest: '阴性' | '阳性' | '未做'
  consentSigned: boolean // 知情同意书
  belongingsSealed: boolean // 随身物品封存
  bagNo: string // 物品袋编号
  greenChannel: boolean // 绿色通道
  note: string
  by: string
  at: number
}

export interface Handover {
  confirmedAt: number // 交接时间
  bagNo: string // 物品袋编号
  contactPhone: string // 术后联系号码
  escortName: string // 确认人（陪诊人）
}

export type ExceptionType =
  | 'bp_abnormal' // 血压异常
  | 'delay' // 手术延迟
  | 'anesthesia_change' // 麻醉方式改变
  | 'escort_leave' // 陪诊人离院
  | 'pickup_change' // 接送人更换
  | 'fee_unpaid' // 费用未结清

export interface ExceptionEvent {
  id: string
  type: ExceptionType
  at: number
  by: string
  detail: string
  resolved: boolean
  resolvedAt?: number
}

export type ProlongedReason = '疼痛' | '恶心呕吐' | '无人接送' | '医生仍需观察'

export interface RecoveryInfo {
  enteredAt: number
  prolongedReason?: ProlongedReason
  prolongedNote?: string
  prolongedBy?: string
}

export interface DischargeChecklist {
  painScore: number // 疼痛评分 0-10
  oralIntake: boolean // 饮水进食
  urination: boolean // 排尿
  medicationTold: boolean // 用药说明已交代
  followupAt: string // 复诊时间 YYYY-MM-DD
  by: string
  at: number
}

export interface PickupSign {
  signer: string
  phone: string
  at: number
}

export interface TimelineEvent {
  id: string
  at: number
  actor: string
  kind: 'status' | 'action' | 'exception' | 'note'
  text: string // 医护端完整描述
  publicText?: string // 家属端脱敏描述（无则不展示）
}

export interface Patient {
  id: string
  name: string
  gender: '男' | '女'
  age: number
  surgeryType: string
  anesthesia: string
  fastingUntil: string // 禁食至
  allergies: string[]
  exams: ExamItem[]
  payment: Payment
  escort: Person // 陪诊人
  pickup: Person // 接送人
  queueNo: number
  status: PatientStatus
  statusAt: Partial<Record<PatientStatus, number>>
  checkedInAt?: number
  assessment?: PreopAssessment
  handover?: Handover
  exceptions: ExceptionEvent[]
  recovery?: RecoveryInfo
  discharge?: DischargeChecklist
  pickupSign?: PickupSign
  delayedMin: number
  timeline: TimelineEvent[]
}

export interface FollowupTask {
  id: string
  patientId: string
  patientName: string
  reason: string
  createdAt: number
  done: boolean
}
