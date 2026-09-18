import { create } from 'zustand'
import type {
  DischargeChecklist,
  ExceptionType,
  FollowupTask,
  Handover,
  Patient,
  PatientStatus,
  Person,
  PreopAssessment,
  ProlongedReason,
  SessionUser,
  TimelineEvent,
} from './types'
import { ACCOUNTS, BASE_NOW, seedPatients, uid } from './data'
import { EX_META, STATUS_META, feeSettled, isProlonged } from './utils'

interface StoreState {
  now: number
  user: SessionUser | null
  patients: Patient[]
  followups: FollowupTask[]

  login: (account: string, password: string) => string | null
  logout: () => void
  tick: (minutes: number) => void

  checkIn: (patientId: string) => void
  saveAssessment: (patientId: string, a: Omit<PreopAssessment, 'by' | 'at'>) => void
  confirmHandover: (patientId: string, h: Omit<Handover, 'confirmedAt'>) => string | null
  advance: (patientId: string) => string | null

  markBpAbnormal: (patientId: string, detail: string) => void
  delaySurgery: (patientId: string, minutes: number, reason: string) => void
  changeAnesthesia: (patientId: string, next: string, reason: string) => void
  escortLeave: (patientId: string) => void
  changePickup: (patientId: string, person: Person) => void
  resolveException: (patientId: string, exId: string) => void

  settlePayment: (patientId: string, amount: number) => void
  setProlongedReason: (patientId: string, reason: ProlongedReason, note: string) => void
  saveDischarge: (patientId: string, d: Omit<DischargeChecklist, 'by' | 'at'>) => string | null
  signPickup: (patientId: string, signer: string, phone: string) => string | null
  completeFollowup: (id: string) => void
}

const STATUS_PUBLIC: Partial<Record<PatientStatus, string>> = {
  registered: '您已完成到院签到，请等待护士术前评估。',
  waiting: '术前评估已完成，请耐心候诊。',
  in_or: '患者已进入手术区。',
  in_surgery: '手术已开始。',
  recovery: '手术已结束，患者正在复苏观察中。',
  ready_pickup: '患者已可离院，等待接送人签收。',
  discharged: '患者已离院，请遵医嘱休养并按时复诊。',
}

function makeEvent(
  now: number,
  actor: string,
  kind: TimelineEvent['kind'],
  text: string,
  publicText?: string,
): TimelineEvent {
  return { id: uid(), at: now, actor, kind, text, publicText }
}

/** 生成异常回访任务（离院签收时调用） */
function buildFollowups(p: Patient, now: number): FollowupTask[] {
  const tasks: FollowupTask[] = []
  const mk = (reason: string): FollowupTask => ({
    id: uid('f'),
    patientId: p.id,
    patientName: p.name,
    reason,
    createdAt: now,
    done: false,
  })
  tasks.push(mk('术后 24 小时常规回访'))
  if (p.discharge && p.discharge.painScore >= 4) tasks.push(mk(`异常回访：离院疼痛评分 ${p.discharge.painScore} 分（≥4）`))
  if (p.recovery?.prolongedReason) tasks.push(mk(`异常回访：复苏滞留（${p.recovery.prolongedReason}）`))
  if (p.exceptions.some((e) => !e.resolved)) tasks.push(mk('异常回访：住院期间存在未闭环异常事件'))
  return tasks
}

export const useStore = create<StoreState>((set, get) => {
  /** 更新单个患者，可附带追加的回访任务 */
  const update = (id: string, fn: (p: Patient) => Patient, extraFollowups: FollowupTask[] = []) =>
    set((s) => ({
      patients: s.patients.map((p) => (p.id === id ? fn(p) : p)),
      followups: extraFollowups.length ? [...s.followups, ...extraFollowups] : s.followups,
    }))

  const actor = () => {
    const u = get().user
    return u ? `${u.title}·${u.name}` : '系统'
  }

  const transit = (p: Patient, to: PatientStatus, now: number, by: string, text?: string): Patient => ({
    ...p,
    status: to,
    statusAt: { ...p.statusAt, [to]: now },
    timeline: [
      ...p.timeline,
      makeEvent(now, by, 'status', text ?? `状态变更：${STATUS_META[to].label}`, STATUS_PUBLIC[to]),
    ],
  })

  return {
    now: BASE_NOW,
    user: null,
    patients: seedPatients(),
    followups: [
      { id: uid('f'), patientId: 'p7', patientName: '孙桂芳', reason: '术后 24 小时常规回访', createdAt: BASE_NOW - 30 * 60000, done: false },
      { id: uid('f'), patientId: 'p7', patientName: '孙桂芳', reason: '异常回访：复苏滞留（恶心呕吐）', createdAt: BASE_NOW - 30 * 60000, done: false },
    ],

    login: (account, password) => {
      const acc = ACCOUNTS.find((a) => a.account === account)
      if (!acc || acc.password !== password) return '账号或密码错误'
      set({ user: { account: acc.account, name: acc.name, role: acc.role, title: acc.title, patientId: acc.patientId } })
      return null
    },
    logout: () => set({ user: null }),
    tick: (minutes) => set((s) => ({ now: s.now + minutes * 60000 })),

    checkIn: (id) =>
      update(id, (p) => {
        const maxQ = Math.max(0, ...get().patients.map((x) => x.queueNo))
        const next = { ...p, queueNo: maxQ + 1, checkedInAt: get().now }
        return transit(next, 'registered', get().now, actor(), '患者到院签到')
      }),

    saveAssessment: (id, a) =>
      update(id, (p) => {
        const now = get().now
        const assessment: PreopAssessment = { ...a, by: actor(), at: now }
        const summary = `术前评估完成：BP ${a.sbp}/${a.dbp}，HR ${a.hr}，SpO2 ${a.spo2}%，体温 ${a.temp}℃，皮试${a.skinTest}` +
          `${a.consentSigned ? '，同意书已签' : '，同意书未签'}${a.belongingsSealed ? `，物品已封存（${a.bagNo}）` : ''}` +
          `${a.greenChannel ? '，绿色通道' : ''}${a.skinTest === '阳性' ? '，皮试阳性已通知医生' : ''}`
        const withA = {
          ...p,
          assessment,
          timeline: [...p.timeline, makeEvent(now, actor(), 'action', summary, '术前评估已完成，请耐心候诊。')],
        }
        // 评估完成后自动进入候诊区（参与候诊排序）
        return p.status === 'registered' ? transit(withA, 'waiting', now, actor(), '进入候诊区等待手术') : withA
      }),

    confirmHandover: (id, h) => {
      const p = get().patients.find((x) => x.id === id)
      if (!p) return '患者不存在'
      if (p.status !== 'waiting') return '当前状态无需交接确认'
      if (p.handover) return '交接已确认，请勿重复操作'
      update(id, (x) => ({
        ...x,
        handover: { ...h, confirmedAt: get().now },
        timeline: [
          ...x.timeline,
          makeEvent(
            get().now,
            actor(),
            'action',
            `陪诊人确认交接：交接时间 ${new Date(get().now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}，物品袋 ${h.bagNo}，术后联系电话 ${h.contactPhone}`,
            '陪诊人已确认交接信息（物品袋编号 / 术后联系号码）。',
          ),
        ],
      }))
      return null
    },

    advance: (id) => {
      const s = get()
      const p = s.patients.find((x) => x.id === id)
      if (!p) return '患者不存在'
      const now = s.now
      switch (p.status) {
        case 'booked':
          return '请先在候诊看板执行到院签到'
        case 'registered':
          return '请先完成术前评估'
        case 'waiting': {
          if (!p.assessment) return '术前评估未完成'
          if (!p.assessment.consentSigned) return '知情同意书未签署，无法入室'
          const undone = p.exams.filter((e) => !e.done)
          if (undone.length) return `术前检查未完成：${undone.map((e) => e.name).join('、')}`
          if (!feeSettled(p) && !p.assessment.greenChannel) return '费用未结清（绿色通道患者可先诊疗后付费）'
          if (!p.handover) return '陪诊人尚未确认交接（物品袋编号 / 术后联系号码）'
          update(id, (x) => transit(x, 'in_or', now, actor(), '患者送入手术间'))
          return null
        }
        case 'in_or':
          update(id, (x) => transit(x, 'in_surgery', now, actor(), '麻醉完成，手术开始'))
          return null
        case 'in_surgery':
          update(id, (x) => ({
            ...transit(x, 'recovery', now, actor(), '手术结束，转入复苏室观察'),
            recovery: { enteredAt: now },
          }))
          return null
        case 'recovery': {
          if (!p.discharge) return '请先完成离院前评估（疼痛评分 / 饮水进食 / 排尿 / 用药说明 / 复诊时间）'
          if (isProlonged(p, now) && !p.recovery?.prolongedReason) return '复苏滞留超过 60 分钟，请先登记滞留原因'
          update(id, (x) => transit(x, 'ready_pickup', now, actor(), '离院评估完成，转入待接走'))
          return null
        }
        case 'ready_pickup': {
          if (!p.pickupSign) return '接送人尚未签收'
          if (!feeSettled(p)) return '费用未结清，无法办理离院'
          const tasks = buildFollowups(p, now)
          update(id, (x) => transit(x, 'discharged', now, actor(), '接送人签收，患者离院'), tasks)
          return null
        }
        case 'discharged':
          return '患者已离院'
      }
    },

    markBpAbnormal: (id, detail) =>
      update(id, (p) => ({
        ...p,
        exceptions: [...p.exceptions, { id: uid(), type: 'bp_abnormal', at: get().now, by: actor(), detail, resolved: false }],
        timeline: [...p.timeline, makeEvent(get().now, actor(), 'exception', `血压异常：${detail}`, EX_META.bp_abnormal.publicText)],
      })),

    delaySurgery: (id, minutes, reason) =>
      update(id, (p) => ({
        ...p,
        delayedMin: p.delayedMin + minutes,
        exceptions: [...p.exceptions, { id: uid(), type: 'delay', at: get().now, by: actor(), detail: `${reason}，预计延迟 ${minutes} 分钟`, resolved: false }],
        timeline: [...p.timeline, makeEvent(get().now, actor(), 'exception', `手术延迟：${reason}，预计延迟 ${minutes} 分钟`, EX_META.delay.publicText)],
      })),

    changeAnesthesia: (id, next, reason) =>
      update(id, (p) => ({
        ...p,
        anesthesia: next,
        exceptions: [...p.exceptions, { id: uid(), type: 'anesthesia_change', at: get().now, by: actor(), detail: `${p.anesthesia} → ${next}（${reason}）`, resolved: false }],
        timeline: [
          ...p.timeline,
          makeEvent(get().now, actor(), 'exception', `麻醉方式改变：${p.anesthesia} → ${next}（${reason}）`, EX_META.anesthesia_change.publicText),
        ],
      })),

    escortLeave: (id) =>
      update(id, (p) => ({
        ...p,
        exceptions: [...p.exceptions, { id: uid(), type: 'escort_leave', at: get().now, by: actor(), detail: `陪诊人 ${p.escort.name} 登记暂时离院`, resolved: false }],
        timeline: [...p.timeline, makeEvent(get().now, actor(), 'exception', `陪诊人 ${p.escort.name} 登记暂时离院`, EX_META.escort_leave.publicText)],
      })),

    changePickup: (id, person) =>
      update(id, (p) => ({
        ...p,
        pickup: person,
        exceptions: [...p.exceptions, { id: uid(), type: 'pickup_change', at: get().now, by: actor(), detail: `接送人更换为 ${person.name}（${person.relation}，${person.phone}）`, resolved: false }],
        timeline: [...p.timeline, makeEvent(get().now, actor(), 'exception', `接送人更换为 ${person.name}（${person.relation}）`, EX_META.pickup_change.publicText)],
      })),

    resolveException: (id, exId) =>
      update(id, (p) => ({
        ...p,
        exceptions: p.exceptions.map((e) => (e.id === exId ? { ...e, resolved: true, resolvedAt: get().now } : e)),
        timeline: [...p.timeline, makeEvent(get().now, actor(), 'note', `异常事件已处理：${EX_META[p.exceptions.find((e) => e.id === exId)?.type ?? 'delay'].label}`)],
      })),

    settlePayment: (id, amount) =>
      update(id, (p) => {
        const paid = Math.min(p.payment.total, p.payment.paid + amount)
        const settled = paid >= p.payment.total
        return {
          ...p,
          payment: { ...p.payment, paid },
          exceptions: p.exceptions.map((e) =>
            e.type === 'fee_unpaid' && settled ? { ...e, resolved: true, resolvedAt: get().now } : e,
          ),
          timeline: [
            ...p.timeline,
            makeEvent(
              get().now,
              actor(),
              'action',
              `收费窗口收款 ${amount} 元，累计 ${paid}/${p.payment.total} 元${settled ? '，费用已结清' : ''}`,
              settled ? '费用已结清。' : undefined,
            ),
          ],
        }
      }),

    setProlongedReason: (id, reason, note) =>
      update(id, (p) => ({
        ...p,
        recovery: { ...p.recovery!, prolongedReason: reason, prolongedNote: note, prolongedBy: actor() },
        timeline: [
          ...p.timeline,
          makeEvent(get().now, actor(), 'note', `复苏滞留原因登记：${reason}${note ? `（${note}）` : ''}`, '患者恢复时间略长，医护人员正在密切观察，请耐心等待。'),
        ],
      })),

    saveDischarge: (id, d) => {
      const p = get().patients.find((x) => x.id === id)
      if (!p) return '患者不存在'
      if (p.status !== 'recovery') return '仅复苏观察中的患者可录入离院评估'
      if (isProlonged(p, get().now) && !p.recovery?.prolongedReason) return '复苏滞留超过 60 分钟，请先在复苏室登记滞留原因'
      update(id, (x) => {
        const now = get().now
        const withD = {
          ...x,
          discharge: { ...d, by: actor(), at: now },
          timeline: [
            ...x.timeline,
            makeEvent(
              now,
              actor(),
              'action',
              `离院评估完成：疼痛 ${d.painScore} 分，${d.oralIntake ? '可饮水进食' : '暂未饮水进食'}，${d.urination ? '已排尿' : '未排尿'}，用药说明已交代，复诊 ${d.followupAt}`,
              '离院评估已完成，等待接送人签收。',
            ),
          ],
        }
        return transit(withD, 'ready_pickup', now, actor(), '离院评估完成，转入待接走')
      })
      return null
    },

    signPickup: (id, signer, phone) => {
      const p = get().patients.find((x) => x.id === id)
      if (!p) return '患者不存在'
      if (p.status !== 'ready_pickup') return '当前状态不可签收'
      if (!feeSettled(p)) return '费用未结清，请通知家属至收费窗口结清后再签收'
      const now = get().now
      const tasks = buildFollowups(p, now)
      update(id, (x) => {
        const signed = {
          ...x,
          pickupSign: { signer, phone, at: now },
          timeline: [...x.timeline, makeEvent(now, actor(), 'action', `接送人 ${signer}（${phone}）签收`, '接送人已签收。')],
        }
        return transit(signed, 'discharged', now, actor(), '接送人签收，患者离院')
      }, tasks)
      return null
    },

    completeFollowup: (fid) =>
      set((s) => ({ followups: s.followups.map((f) => (f.id === fid ? { ...f, done: true } : f)) })),
  }
})
