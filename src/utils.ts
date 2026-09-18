import type { ExceptionType, Patient, PatientStatus } from './types'

// ---------- 时间 ----------
export const fmtTime = (t?: number): string =>
  t == null
    ? '—'
    : new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

export const fmtDateTime = (t?: number): string =>
  t == null ? '—' : `${new Date(t).toLocaleDateString('zh-CN')} ${fmtTime(t)}`

export const fmtDur = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m >= 60 ? `${Math.floor(m / 60)}小时${m % 60}分` : `${m}分钟`
}

// ---------- 状态元信息 ----------
export const STATUS_META: Record<PatientStatus, { label: string; color: string }> = {
  booked: { label: '待签到', color: '#94a3b8' },
  registered: { label: '已签到', color: '#64748b' },
  waiting: { label: '候诊中', color: '#d97706' },
  in_or: { label: '已入室', color: '#2563eb' },
  in_surgery: { label: '手术中', color: '#dc2626' },
  recovery: { label: '复苏观察', color: '#ea580c' },
  ready_pickup: { label: '待接走', color: '#0891b2' },
  discharged: { label: '已离院', color: '#16a34a' },
}

// 家属端可见的脱敏状态节点
export const FAMILY_STEPS: PatientStatus[] = [
  'registered',
  'waiting',
  'in_or',
  'in_surgery',
  'recovery',
  'ready_pickup',
  'discharged',
]

// ---------- 异常元信息 ----------
export const EX_META: Record<ExceptionType, { label: string; publicText: string }> = {
  bp_abnormal: { label: '血压异常', publicText: '患者术前检查指标有波动，医护人员正在密切处理，请耐心等待。' },
  delay: { label: '手术延迟', publicText: '手术安排略有延迟，具体进展请咨询护士站，请耐心等待。' },
  anesthesia_change: { label: '麻醉方式改变', publicText: '医疗团队已根据患者情况调整手术方案，请放心。' },
  escort_leave: { label: '陪诊人离院', publicText: '陪诊人已暂时离院，如需联系请保持电话畅通。' },
  pickup_change: { label: '接送人更换', publicText: '接送人信息已更新。' },
  fee_unpaid: { label: '费用未结清', publicText: '费用待结清，请家属前往收费窗口办理。' },
}

// ---------- 业务规则 ----------
export const feeSettled = (p: Patient): boolean => p.payment.paid >= p.payment.total

export const RECOVERY_LIMIT_MIN = 60

/** 复苏是否滞留（超过阈值） */
export const isProlonged = (p: Patient, now: number): boolean => {
  if (!p.recovery) return false
  const end =
    p.status === 'recovery'
      ? now
      : (p.discharge?.at ?? p.pickupSign?.at ?? p.statusAt.ready_pickup ?? now)
  return end - p.recovery.enteredAt > RECOVERY_LIMIT_MIN * 60000
}

/** 候诊区排序：绿色通道优先，其余按签到顺序 */
export function waitingQueue(patients: Patient[]): Patient[] {
  return patients
    .filter((p) => p.status === 'waiting')
    .sort((a, b) => {
      const ga = a.assessment?.greenChannel ? 1 : 0
      const gb = b.assessment?.greenChannel ? 1 : 0
      if (ga !== gb) return gb - ga
      return a.queueNo - b.queueNo
    })
}

/** 预计手术顺序（仅候诊中患者有） */
export function expectedOrder(patients: Patient[]): Map<string, number> {
  const m = new Map<string, number>()
  waitingQueue(patients).forEach((p, i) => m.set(p.id, i + 1))
  return m
}

/** 进入手术间前的前置条件检查 */
export function enterOrBlockers(p: Patient): string[] {
  const blockers: string[] = []
  if (!p.assessment) blockers.push('术前评估未完成')
  if (p.assessment && !p.assessment.consentSigned) blockers.push('知情同意书未签署')
  const undone = p.exams.filter((e) => !e.done).map((e) => e.name)
  if (undone.length) blockers.push(`术前检查未完成：${undone.join('、')}`)
  if (!feeSettled(p) && !p.assessment?.greenChannel) blockers.push('费用未结清（绿色通道可先诊疗后付费）')
  if (!p.handover) blockers.push('陪诊人未确认交接（物品袋编号 / 术后联系号码）')
  return blockers
}

/** 手术间准备提示（逐项） */
export function orReadyChecklist(p: Patient): { label: string; ok: boolean }[] {
  return [
    { label: '术前评估已录入', ok: !!p.assessment },
    { label: '知情同意书已签署', ok: !!p.assessment?.consentSigned },
    { label: '术前检查齐全', ok: p.exams.every((e) => e.done) },
    { label: '随身物品已封存', ok: !!p.assessment?.belongingsSealed },
    { label: '费用已结清 / 绿色通道', ok: feeSettled(p) || !!p.assessment?.greenChannel },
    { label: '陪诊人交接已确认', ok: !!p.handover },
  ]
}

// ---------- 术后注意事项生成 ----------
export function buildPostopNotes(p: Patient): string[] {
  const notes: string[] = []
  if (p.anesthesia.includes('全麻')) {
    notes.push('全麻术后 6 小时内去枕平卧、禁食禁水，之后遵医嘱逐步恢复饮水进食。')
    notes.push('24 小时内不得驾车、登高或签署重要文件，需有成人陪同。')
  } else if (p.anesthesia.includes('腰麻') || p.anesthesia.includes('椎管内')) {
    notes.push('腰麻术后去枕平卧 6 小时，避免抬头，防止头痛。')
    notes.push('下肢感觉未完全恢复前请勿自行下床，防止跌倒。')
  } else {
    notes.push('局部麻醉术后可正常活动，但术区避免用力与碰撞。')
  }
  if (p.surgeryType.includes('腹腔镜') || p.surgeryType.includes('胆囊')) {
    notes.push('保持腹部切口敷料干燥，3 天内避免淋浴浸湿；如出现发热、腹痛加剧请及时就诊。')
  }
  if (p.surgeryType.includes('白内障') || p.surgeryType.includes('眼')) {
    notes.push('术眼避免揉压，遵医嘱按时滴用眼药水，外出佩戴防护眼罩。')
  }
  if (p.surgeryType.includes('关节') || p.surgeryType.includes('半月板')) {
    notes.push('患肢按康复计划制动与负重，冰敷每次 15-20 分钟，每日 3 次。')
  }
  notes.push('遵医嘱按时按量服药，不要自行增减或停用。')
  if (p.discharge?.followupAt) notes.push(`请于 ${p.discharge.followupAt} 按时复诊。`)
  notes.push('如出现持续高热、剧烈疼痛、伤口渗血渗液等异常，请立即拨打日间手术中心回访电话 0571-8888-6666。')
  return notes
}

// ---------- 统计 ----------
export interface DayStats {
  checkedIn: number
  inSurgery: number
  inRecovery: number
  discharged: number
  avgRecoveryMin: number | null
  avgTurnoverMin: number | null
  prolonged: { patient: Patient; reason: string }[]
  exceptionCount: Record<string, number>
}

export function computeStats(patients: Patient[]): DayStats {
  const active = patients.filter((p) => p.status !== 'booked')
  const discharged = patients.filter((p) => p.status === 'discharged')

  const recoveryDurs = discharged
    .filter((p) => p.recovery && p.discharge)
    .map((p) => (p.discharge!.at - p.recovery!.enteredAt) / 60000)
  const turnoverDurs = discharged
    .filter((p) => p.statusAt.in_or && p.statusAt.discharged)
    .map((p) => (p.statusAt.discharged! - p.statusAt.in_or!) / 60000)

  const exceptionCount: Record<string, number> = {}
  patients.forEach((p) =>
    p.exceptions.forEach((e) => {
      exceptionCount[e.type] = (exceptionCount[e.type] ?? 0) + 1
    }),
  )

  return {
    checkedIn: active.length,
    inSurgery: patients.filter((p) => p.status === 'in_or' || p.status === 'in_surgery').length,
    inRecovery: patients.filter((p) => p.status === 'recovery').length,
    discharged: discharged.length,
    avgRecoveryMin: recoveryDurs.length
      ? Math.round(recoveryDurs.reduce((a, b) => a + b, 0) / recoveryDurs.length)
      : null,
    avgTurnoverMin: turnoverDurs.length
      ? Math.round(turnoverDurs.reduce((a, b) => a + b, 0) / turnoverDurs.length)
      : null,
    prolonged: patients
      .filter((p) => p.recovery?.prolongedReason)
      .map((p) => ({ patient: p, reason: p.recovery!.prolongedReason! })),
    exceptionCount,
  }
}
