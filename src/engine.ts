import type {
  BaseEvent, Patient, PatientAggregate, Report, FollowUpTask, Order,
  PharmacyAdvice, Referral, Closure, SlaReminder, NotificationRecord,
  User, Role, Channel, EventType,
} from './types';
import { uid, evaluateReport, gradePatient, postDischarge, detectInteractions } from './rules';

// ============ 错误类型 ============
export class DomainError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// ============ 系统状态 ============
export interface SystemState {
  patients: Patient[];
  users: User[];
  events: BaseEvent[];
  /** 模拟异步通知通道故障（true 时发出的通知全部失败，进入 outbox 待人工重试） */
  notifyChannelDown: boolean;
}

export interface Actor {
  id: string;
  role: Role;
}

type NewEvent = Omit<BaseEvent, 'id' | 'version' | 'recordedAt'>;

// ============ 事件提交（幂等 + 乐观并发） ============
export function patientVersion(state: SystemState, patientId: string): number {
  let v = 0;
  for (const e of state.events) if (e.patientId === patientId) v++;
  return v;
}

/**
 * 原子提交一个命令产生的事件序列（同一患者聚合）。
 * - commandId 幂等：重复命令（双击/多入口重复提交/网络重试）整体丢弃
 * - expectedVersion：乐观锁，防止角色并发操作互相覆盖
 */
export function commit(
  state: SystemState,
  patientId: string,
  buildEvents: () => NewEvent[],
  now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): BaseEvent[] {
  if (opts.commandId) {
    for (const e of state.events) {
      if (e.commandId === opts.commandId) return []; // 幂等命中
    }
  }
  const current = patientVersion(state, patientId);
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== current) {
    throw new DomainError(
      'CONCURRENT_CONFLICT',
      `数据已被其他角色更新（版本 ${opts.expectedVersion} → ${current}），请刷新到最新时间线后重试`,
    );
  }
  const built = buildEvents();
  let version = current;
  const stamped = built.map((e) => ({
    ...e,
    id: uid('evt'),
    recordedAt: now,
    version: ++version,
    commandId: opts.commandId ?? e.commandId,
  })) as BaseEvent[];
  state.events.push(...stamped);
  return stamped;
}

// ============ 投影：事件 → 聚合 ============
export function project(state: SystemState, patientId: string): PatientAggregate {
  const patient = state.patients.find((p) => p.id === patientId);
  if (!patient) throw new DomainError('PATIENT_NOT_FOUND', `患者 ${patientId} 不存在`);

  const reports: Report[] = [];
  const tasks = new Map<string, FollowUpTask>();
  const orders: Order[] = [];
  const advices: PharmacyAdvice[] = [];
  const referrals = new Map<string, Referral>();
  const closures: Closure[] = [];
  const reminders: SlaReminder[] = [];
  const notifications: NotificationRecord[] = [];
  let consentDeclined = false;

  const evts = state.events
    .filter((e) => e.patientId === patientId)
    .sort((a, b) => a.version - b.version);

  for (const e of evts) {
    const p = e.payload;
    switch (e.type) {
      case 'followup_plan_generated':
        break;
      case 'task_created': {
        // 合并语义：plan_superseded 可能已先插入带 replacesTaskId 的任务实体，此处不能覆盖关系字段
        const nt = p.task as FollowUpTask;
        const prev = tasks.get(nt.id);
        tasks.set(nt.id, {
          ...nt, patientId,
          replacesTaskId: prev?.replacesTaskId ?? nt.replacesTaskId,
          supersededBy: prev?.supersededBy ?? nt.supersededBy,
        });
        break;
      }
      case 'patient_reported': {
        reports.push({
          id: String(p.reportId), eventId: e.id, patientId,
          channel: p.channel as Channel,
          occurredAt: e.occurredAt, recordedAt: e.recordedAt,
          symptoms: p.symptoms as string[],
          temperature: p.temperature as number | undefined,
          systolic: p.systolic as number | undefined,
          diastolic: p.diastolic as number | undefined,
          adherence: p.adherence as Report['adherence'],
          imageIds: p.imageIds as string[],
          imageReadable: p.imageReadable as boolean,
          note: p.note as string | undefined,
          risk: p.risk as Report['risk'],
          triggeredRules: p.triggeredRules as string[],
          duplicateOf: p.duplicateOf as string | undefined,
          escalationId: p.escalationId as string | undefined,
          handled: false,
        });
        break;
      }
      case 'risk_escalated':
        break; // 任务实体由 task_created 承载
      case 'manual_queued':
        break;
      case 'consent_declined':
        consentDeclined = true;
        break;
      case 'consent_expired':
      case 'image_unreadable':
      case 'nurse_screened':
      case 'phone_logged':
      case 'er_advised':
        break;
      case 'task_status_changed': {
        const t = tasks.get(String(e.taskId ?? p.taskId));
        if (t) {
          t.status = p.status as FollowUpTask['status'];
          if (p.status === 'done' || p.status === 'cancelled') t.closedAt = e.occurredAt;
          if (p.reason) {
            t.supersededBy = {
              eventId: e.id, reason: String(p.reason),
              newTaskId: p.newTaskId as string | undefined,
            };
          }
        }
        break;
      }
      case 'plan_superseded': {
        // 医嘱与随访计划冲突：旧任务取消（保留取消事实），必要时创建替代任务
        for (const oldId of (p.oldTaskIds as string[]) ?? []) {
          const t = tasks.get(oldId);
          if (t && t.status !== 'done' && t.status !== 'cancelled') {
            t.status = 'cancelled';
            t.closedAt = e.occurredAt;
            t.supersededBy = {
              eventId: e.id,
              reason: `新医嘱「${String(p.orderContent)}」与既有计划冲突：${String(p.conflict)}`,
              newTaskId: (p.replacementById as Record<string, string>)?.[oldId],
            };
          }
        }
        for (const nt of (p.newTasks as FollowUpTask[]) ?? []) {
          const map = p.replacementById as Record<string, string> | undefined;
          tasks.set(nt.id, { ...nt, patientId, replacesTaskId: map &&
            Object.entries(map).find(([, newId]) => newId === nt.id)?.[0] });
        }
        break;
      }
      case 'order_added': {
        orders.push({
          id: String(p.orderId), eventId: e.id, patientId,
          content: String(p.content), status: 'active',
          orderedAt: e.occurredAt, recordedAt: e.recordedAt,
          backdated: Boolean(p.backdated),
        });
        break;
      }
      case 'order_withdrawn': {
        const o = orders.find((x) => x.id === p.orderId);
        if (o) {
          o.status = 'withdrawn';
          o.withdrawnByEventId = e.id;
          o.withdrawReason = String(p.reason);
        }
        // 撤回不复活已取消任务（取消是既成事实），而是新建恢复性随访任务
        for (const nt of (p.restoreTasks as FollowUpTask[]) ?? []) {
          tasks.set(nt.id, { ...nt, patientId });
        }
        break;
      }
      case 'pharmacy_review': {
        advices.push({
          id: String(p.adviceId), eventId: e.id, patientId,
          taskId: p.taskId as string | undefined,
          interaction: String(p.interaction), advice: String(p.advice),
          severity: p.severity as PharmacyAdvice['severity'],
          createdAt: e.occurredAt,
        });
        break;
      }
      case 'referral_requested': {
        referrals.set(String(p.referralId), {
          id: String(p.referralId), taskId: String(e.taskId ?? p.taskId), patientId,
          reason: String(p.reason), targetDept: String(p.targetDept),
          status: 'requested', requestedAt: e.occurredAt, pendingNotes: [],
        });
        break;
      }
      case 'referral_confirmed': {
        const r = referrals.get(String(p.referralId));
        if (r) { r.status = 'confirmed'; r.confirmedAt = e.occurredAt; }
        break;
      }
      case 'referral_rejected': {
        const r = referrals.get(String(p.referralId));
        if (r) { r.status = 'rejected'; r.rejectedAt = e.occurredAt; r.rejectReason = String(p.reason); }
        break;
      }
      case 'note_added': {
        const r = [...referrals.values()].find((x) => x.status === 'requested');
        if (r) {
          r.pendingNotes.push({
            at: e.occurredAt, reportId: String(p.refReportId ?? ''), text: String(p.text),
          });
        }
        break;
      }
      case 'case_closed': {
        const closedTaskId = String(e.taskId ?? p.taskId);
        closures.push({
          taskId: closedTaskId, eventId: e.id,
          basis: String(p.basis), closedAt: e.occurredAt,
        });
        const t = tasks.get(closedTaskId);
        if (t) { t.status = 'done'; t.closedAt = e.occurredAt; }
        break;
      }
      case 'case_reopened': {
        const reopenedId = String(e.taskId ?? p.taskId);
        const idx = closures.findIndex((c) => c.taskId === reopenedId);
        if (idx >= 0) closures.splice(idx, 1);
        const t = tasks.get(reopenedId);
        if (t) { t.status = 'open'; t.closedAt = undefined; }
        break;
      }
      case 'sla_reminder': {
        reminders.push({
          eventId: e.id, taskId: String(e.taskId ?? p.taskId), at: e.occurredAt, count: Number(p.count),
        });
        break;
      }
      case 'notification_sent': {
        notifications.push({
          eventId: e.id, channel: p.channel as NotificationRecord['channel'],
          target: String(p.target), purpose: String(p.purpose),
          status: p.status as NotificationRecord['status'], at: e.occurredAt,
          failReason: p.failReason as string | undefined,
        });
        break;
      }
      default: {
        const _exhaustive: never = e.type;
        void _exhaustive;
      }
    }
  }

  // 上报是否已随升级任务闭环
  for (const r of reports) {
    if (r.duplicateOf) {
      const orig = reports.find((x) => x.id === r.duplicateOf);
      r.handled = orig?.handled ?? false;
    } else if (r.escalationId) {
      r.handled = tasks.get(r.escalationId)?.status === 'done';
    } else {
      r.handled = true;
    }
  }

  return {
    patient: { ...patient, consent: { ...patient.consent, declinedContact: consentDeclined } },
    reports: reports.sort((a, b) => +new Date(a.occurredAt) - +new Date(b.occurredAt)),
    tasks: [...tasks.values()].sort((a, b) => +new Date(a.dueAt) - +new Date(b.dueAt)),
    orders: orders.sort((a, b) => +new Date(a.orderedAt) - +new Date(b.orderedAt)),
    advices, referrals: [...referrals.values()],
    closures, reminders, notifications,
    version: evts.length,
  };
}

// ============ 角色守卫 ============
function requireRole(actor: Actor, roles: Role[], action: string): void {
  if (!roles.includes(actor.role)) {
    throw new DomainError('FORBIDDEN', `${action}：当前角色无权操作（需要 ${roles.join('/')}）`);
  }
}

// ============ 判重指纹 ============
function fingerprint(input: { symptoms: string[]; temperature?: number; systolic?: number; diastolic?: number }): string {
  const norm = [
    [...input.symptoms].sort().join('|'),
    input.temperature ? Math.round(input.temperature * 10) : '',
    input.systolic ?? '', input.diastolic ?? '',
  ].join('#');
  let h = 0;
  for (const ch of norm) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return `fp_${(h >>> 0).toString(36)}`;
}

const DUP_WINDOW_MS = 2 * 3600_000; // 2 小时判重窗口
const HIGH_SLA_HOURS = 2; // 高风险 2 小时内必须闭环
const QUEUE_SLA_HOURS = 24;

function notify(
  state: SystemState, evts: NewEvent[], patientId: string, at: string,
  target: string, purpose: string, channel: NotificationRecord['channel'] = 'app_push',
): void {
  // 模拟异步通知：通道故障时记录失败事件（outbox），不阻断主流程，由人工队列/重试兜底
  const failed = state.notifyChannelDown;
  evts.push({
    type: 'notification_sent', patientId, occurredAt: at,
    actorId: 'system', actorRole: 'system',
    payload: failed
      ? { channel, target, purpose, status: 'failed', failReason: '异步通知通道不可用（已进入 outbox 待重试）' }
      : { channel, target, purpose, status: 'success' },
  });
}

function makeTask(t: FollowUpTask): NewEvent {
  return {
    type: 'task_created', patientId: t.patientId, occurredAt: t.createdAt,
    actorId: 'system', actorRole: 'system', payload: { task: t },
  };
}

// ============ 命令 1：生成出院分级随访计划 ============
export function generateFollowupPlan(state: SystemState, patientId: string, now: string): BaseEvent[] {
  const patient = state.patients.find((p) => p.id === patientId)!;
  const { level, reasons, scheduleDays } = gradePatient(patient);
  return commit(state, patientId, () => {
    const evts: NewEvent[] = [{
      type: 'followup_plan_generated', patientId, occurredAt: now,
      actorId: 'system', actorRole: 'system', payload: { level, reasons, scheduleDays },
    }];
    for (const day of scheduleDays) {
      evts.push(makeTask({
        id: uid('task'), patientId, type: 'routine_followup',
        title: `出院后第 ${day} 天常规随访（${level}）`, level,
        status: 'scheduled', dueAt: postDischarge(patient.dischargeDate, day, 9),
        scheduledDay: day, createdAt: now,
      }));
    }
    return evts;
  }, now);
}

// ============ 命令 2：患者受限入口上报 ============
export interface ReportInput {
  channel: Channel;
  symptoms: string[];
  temperature?: number;
  systolic?: number;
  diastolic?: number;
  adherence: Report['adherence'];
  imageIds: string[];
  imagesReadable: boolean;
  note?: string;
  occurredAt?: string; // 业务时间（热线代录时可与系统时间不同）
}

export interface SubmitResult {
  events: BaseEvent[];
  reportId: string;
  duplicate: boolean;
  risk: Report['risk'];
  escalationTaskId?: string;
  ruleHits: string[];
  queued: { taskId: string; reason: string }[];
}

export function submitReport(
  state: SystemState,
  patientId: string,
  actor: Actor,
  input: ReportInput,
  now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): SubmitResult {
  if (actor.role === 'patient' && input.channel === 'hotline') {
    throw new DomainError('FORBIDDEN', '热线入口仅支持护士代录，患者本人请使用小程序或短信入口');
  }
  if (actor.role === 'nurse' && input.channel !== 'hotline') {
    throw new DomainError('FORBIDDEN', '护士仅可在热线场景代录上报，不得使用患者自助入口');
  }
  if (actor.role !== 'patient' && actor.role !== 'nurse') {
    throw new DomainError('FORBIDDEN', '仅患者本人或热线护士（代录）可提交上报');
  }
  const patient = state.patients.find((p) => p.id === patientId)!;
  const occurredAt = input.occurredAt ?? now;
  const evalResult = evaluateReport(patient, input);
  const fp = fingerprint(input);
  const reportId = uid('rep');

  let result: SubmitResult = {
    events: [], reportId, duplicate: false, risk: evalResult.level,
    ruleHits: evalResult.rules, queued: [],
  };

  const evts = commit(state, patientId, () => {
    const out: NewEvent[] = [];
    const agg = project(state, patientId);

    // —— 判重：2 小时窗口、不同入口、相同内容指纹 ——
    const dup = agg.reports.find(
      (r) =>
        Math.abs(+new Date(r.occurredAt) - +new Date(occurredAt)) <= DUP_WINDOW_MS &&
        fingerprint(r) === fp,
    );
    if (dup) result.duplicate = true;

    // —— 授权检查 ——
    const consentExpired = +new Date(now) > +new Date(patient.consent.validUntil);
    const declined = agg.patient.consent.declinedContact;

    const openEscalation = agg.tasks.find(
      (t) => t.type === 'escalation' && (t.status === 'open' || t.status === 'in_progress'),
    );
    const closedEscalation = [...agg.tasks]
      .reverse()
      .find((t) => t.type === 'escalation' && t.status === 'done');

    let escalationId: string | undefined;

    if (evalResult.level === 'high') {
      if (openEscalation) {
        // 已有进行中升级：不重复建升级任务；转诊待确认期间的恶化挂到转诊单
        escalationId = openEscalation.id;
        const pending = agg.referrals.find((r) => r.status === 'requested');
        if (pending) {
          out.push({
            type: 'note_added', patientId, occurredAt: now,
            actorId: actor.id, actorRole: actor.role,
            payload: {
              refReportId: reportId,
              text: `转诊确认前患者再次上报恶化：${input.symptoms.join('、') || '体征异常'}（不另开转诊单）`,
            },
          });
        }
        notify(state, out, patientId, now, 'role:nurse', `升级任务 ${openEscalation.id} 收到再次上报（恶化补充）`);
      } else if (closedEscalation) {
        // 关闭后再次上报恶化：重开原升级事件（旧关闭记录保留在时间线），不新建
        escalationId = closedEscalation.id;
        out.push({
          type: 'case_reopened', patientId, occurredAt: now,
          actorId: 'system', actorRole: 'system',
          payload: { taskId: closedEscalation.id, sourceReportId: reportId,
            reason: '闭环后再次上报高风险，原升级事件重开追踪' },
        });
        // 重开后重新冻结普通自动随访
        for (const t of agg.tasks) {
          if (t.type === 'routine_followup' && t.status === 'scheduled') {
            out.push({
              type: 'task_status_changed', patientId, occurredAt: now,
              actorId: 'system', actorRole: 'system',
              payload: { taskId: t.id, status: 'frozen', reason: '升级事件重开：普通自动随访重新冻结' },
            });
          }
        }
        notify(state, out, patientId, now, 'role:nurse', '已闭环事件因再次恶化重开');
      } else {
        const taskId = uid('task');
        result.escalationTaskId = taskId;
        escalationId = taskId;
        out.push({
          type: 'risk_escalated', patientId, occurredAt: now,
          actorId: 'system', actorRole: 'system',
          payload: {
            sourceReportId: reportId, escalationTaskId: taskId,
            summary: evalResult.rules.join('；'),
            dueAt: new Date(+new Date(now) + HIGH_SLA_HOURS * 3600_000).toISOString(),
          },
        });
        out.push(makeTask({
          id: taskId, patientId, type: 'escalation',
          title: `高风险升级：${evalResult.rules[0] ?? '命中高风险规则'}`, level: 'L3',
          status: 'open',
          dueAt: new Date(+new Date(now) + HIGH_SLA_HOURS * 3600_000).toISOString(),
          createdAt: now, sourceReportId: reportId,
        }));
        // 冻结该患者所有未完成的常规自动随访（保留任务，状态 frozen，不删除）
        for (const t of agg.tasks) {
          if (t.type === 'routine_followup' && (t.status === 'scheduled' || t.status === 'frozen')) {
            out.push({
              type: 'task_status_changed', patientId, occurredAt: now,
              actorId: 'system', actorRole: 'system',
              payload: { taskId: t.id, status: 'frozen', reason: '高风险升级：普通自动随访冻结' },
            });
          }
        }
        notify(state, out, patientId, now, 'role:nurse', `高风险升级任务待初筛（${HIGH_SLA_HOURS}h 时限）`);
      }
    }

    out.unshift({
      type: 'patient_reported', patientId, occurredAt,
      actorId: actor.id, actorRole: actor.role,
      payload: {
        reportId, channel: input.channel,
        symptoms: input.symptoms,
        temperature: input.temperature, systolic: input.systolic, diastolic: input.diastolic,
        adherence: input.adherence, imageIds: input.imageIds,
        imageReadable: input.imagesReadable, note: input.note,
        risk: evalResult.level, triggeredRules: evalResult.rules,
        fingerprint: fp,
        duplicateOf: dup?.id,
        escalationId,
      },
    });

    // —— 人工队列触发 —— 同一次上报的多个原因合并为一个队列任务（避免重复排队）
    const queueReasons: { reason: string; level: NonNullable<FollowUpTask['level']> }[] = [];
    const enqueue = (reason: string, level: FollowUpTask['level']) => {
      if (!queueReasons.some((q) => q.reason === reason)) queueReasons.push({ reason, level: level ?? 'L2' });
    };

    if (!result.duplicate) {
      if (declined) enqueue('患者已拒绝主动联系，需人工核实随访方式', evalResult.level === 'high' ? 'L3' : 'L2');
      if (consentExpired) {
        out.push({
          type: 'consent_expired', patientId, occurredAt: now,
          actorId: 'system', actorRole: 'system',
          payload: { validUntil: patient.consent.validUntil },
        });
        enqueue('数据授权已过期，暂停自动处理并转人工', 'L2');
      }
      if (input.imageIds.length > 0 && !input.imagesReadable) {
        out.push({
          type: 'image_unreadable', patientId, occurredAt: now,
          actorId: 'system', actorRole: 'system',
          payload: { imageIds: input.imageIds },
        });
        enqueue('患者上传图片无法读取，需人工联系重新获取', 'L2');
      }
      if (evalResult.level === 'medium' && !openEscalation) {
        enqueue('中风险症状待护士复核', 'L2');
      }
    }

    // 通知失败兜底：异步通知失败 → 人工队列，保证不漏随访
    if (state.notifyChannelDown && evalResult.level !== 'low') {
      enqueue('异步通知下发失败，需人工盯办（outbox 重试）', evalResult.level === 'high' ? 'L3' : 'L2');
    }

    if (queueReasons.length > 0) {
      const level = queueReasons.some((q) => q.level === 'L3') ? 'L3' : 'L2';
      const reason = queueReasons.map((q) => q.reason).join('；');
      const taskId = uid('task');
      result.queued.push({ taskId, reason });
      out.push({
        type: 'manual_queued', patientId, occurredAt: now,
        actorId: 'system', actorRole: 'system',
        payload: { reason, taskId, level, sourceReportId: reportId },
      });
      out.push(makeTask({
        id: taskId, patientId, type: 'manual_queue',
        title: `人工队列：${queueReasons[0].reason}${queueReasons.length > 1 ? ` 等 ${queueReasons.length} 项` : ''}`,
        level, status: 'open',
        dueAt: new Date(+new Date(now) + QUEUE_SLA_HOURS * 3600_000).toISOString(),
        createdAt: now, queueReason: reason, sourceReportId: reportId,
      }));
    }
    return out;
  }, now, opts);

  result.events = evts;
  return result;
}

// ============ 命令 3：患者拒绝联系 ============
export function declineContact(
  state: SystemState, patientId: string, actor: Actor, reason: string, now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): BaseEvent[] {
  const events = commit(state, patientId, () => {
    const taskId = uid('task');
    const out: NewEvent[] = [{
      type: 'consent_declined', patientId, occurredAt: now,
      actorId: actor.id, actorRole: actor.role, payload: { reason },
    }, {
      type: 'manual_queued', patientId, occurredAt: now,
      actorId: 'system', actorRole: 'system',
      payload: { reason: `患者拒绝联系：${reason}`, taskId, level: 'L2' },
    }, makeTask({
      id: taskId, patientId, type: 'manual_queue',
      title: `人工队列：患者拒绝联系（${reason}）`, level: 'L2', status: 'open',
      dueAt: new Date(+new Date(now) + QUEUE_SLA_HOURS * 3600_000).toISOString(),
      createdAt: now, queueReason: '患者拒绝联系',
    })];
    notify(state, out, patientId, now, 'role:nurse', '患者拒绝联系，已转人工队列');
    return out;
  }, now, opts);
  return events;
}

// ============ 命令 4：护士初筛 ============
export type ScreenDecision =
  | { kind: 'phone_callback'; note: string; reached: boolean }
  | { kind: 'er_advice'; note: string }
  | { kind: 'referral_request'; reason: string; targetDept: string };

export function nurseScreen(
  state: SystemState, patientId: string, taskId: string,
  actor: Actor, decision: ScreenDecision, now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): { events: BaseEvent[]; referralId?: string } {
  requireRole(actor, ['nurse'], '护士初筛');
  let referralId: string | undefined;
  const events = commit(state, patientId, () => {
    const agg = project(state, patientId);
    const task = agg.tasks.find((t) => t.id === taskId);
    if (!task || task.type !== 'escalation') throw new DomainError('TASK_NOT_FOUND', '升级任务不存在');
    if (task.status === 'done') throw new DomainError('TASK_CLOSED', '任务已关闭，不能再初筛');
    if (task.status === 'cancelled') throw new DomainError('TASK_CANCELLED', '任务已取消');

    const out: NewEvent[] = [];
    if (task.status === 'open') {
      out.push({
        type: 'task_status_changed', patientId, occurredAt: now,
        actorId: actor.id, actorRole: actor.role,
        payload: { taskId, status: 'in_progress', reason: '护士开始初筛' },
      });
    }
    out.push({
      type: 'nurse_screened', patientId, taskId, occurredAt: now,
      actorId: actor.id, actorRole: actor.role,
      payload: { decision: decision.kind, ...decision },
    });

    if (decision.kind === 'phone_callback') {
      out.push({
        type: 'phone_logged', patientId, taskId, occurredAt: now,
        actorId: actor.id, actorRole: actor.role,
        payload: { note: decision.note, reached: decision.reached },
      });
    } else if (decision.kind === 'er_advice') {
      out.push({
        type: 'er_advised', patientId, taskId, occurredAt: now,
        actorId: actor.id, actorRole: actor.role, payload: { note: decision.note },
      });
      notify(state, out, patientId, now, patientId, `急诊建议通知：${decision.note}`, 'sms');
    } else {
      // 转诊唯一性：同一患者只要存在 requested/confirmed 转诊即拒绝再开
      const active = agg.referrals.find((r) => r.status === 'requested' || r.status === 'confirmed');
      if (active) {
        throw new DomainError(
          'REFERRAL_EXISTS',
          `已存在${active.status === 'requested' ? '待确认' : '已确认'}转诊单 ${active.id}，禁止重复转诊（恶化信息已挂接到原单）`,
        );
      }
      referralId = uid('ref');
      out.push({
        type: 'referral_requested', patientId, taskId, occurredAt: now,
        actorId: actor.id, actorRole: actor.role,
        payload: { referralId, reason: decision.reason, targetDept: decision.targetDept },
      });
      notify(state, out, patientId, now, `dept:${decision.targetDept}`, `新转诊申请：${decision.reason}`);
    }
    return out;
  }, now, opts);
  return { events, referralId };
}

// ============ 命令 5：转诊确认/驳回 ============
export function resolveReferral(
  state: SystemState, patientId: string, referralId: string,
  actor: Actor, action: 'confirmed' | 'rejected', note: string, now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): BaseEvent[] {
  requireRole(actor, ['doctor'], action === 'confirmed' ? '转诊确认' : '转诊驳回');
  return commit(state, patientId, () => {
    const agg = project(state, patientId);
    const ref = agg.referrals.find((r) => r.id === referralId);
    if (!ref) throw new DomainError('REFERRAL_NOT_FOUND', '转诊单不存在');
    if (ref.status !== 'requested') throw new DomainError('REFERRAL_NOT_PENDING', `转诊单当前状态 ${ref.status}，不能重复操作`);
    return [{
      type: action === 'confirmed' ? 'referral_confirmed' : 'referral_rejected',
      patientId, taskId: ref.taskId, occurredAt: now,
      actorId: actor.id, actorRole: actor.role,
      payload: action === 'confirmed'
        ? { referralId, note }
        : { referralId, reason: note },
    }];
  }, now, opts);
}

// ============ 命令 6：医生补充医嘱（可能与既有随访计划冲突） ============
export interface AddOrderInput {
  content: string;
  effectiveAt: string; // 医嘱业务时间（允许补录为更早时间）
  /** 需要取消/替代的既有常规任务（UI 依据冲突检测结果勾选） */
  supersedeTaskIds?: string[];
  /** 替代任务的新执行时间（与 supersedeTaskIds 一一对应，可选） */
  replacementDueAt?: Record<string, string>;
}

export interface AddOrderResult {
  events: BaseEvent[];
  orderId: string;
  backdated: boolean;
  conflicts: { task: FollowUpTask; reason: string }[];
  interactions: ReturnType<typeof detectInteractions>;
}

/** 冲突检测：医嘱要求提前复诊/停药/换药/加药监测时，晚于医嘱生效时间的未完成常规随访都受影响 */
export function detectOrderConflicts(
  state: SystemState, patientId: string, content: string, effectiveAt: string,
): { task: FollowUpTask; reason: string }[] {
  const agg = project(state, patientId);
  const reasons: string[] = [];
  if (/停|暂停|换药/.test(content)) reasons.push('医嘱停用/更换药物，原计划用药随访项失去依据');
  if (/提前|急诊|即刻|立即/.test(content)) reasons.push('医嘱要求即刻/提前处置，原排期时间点滞后');
  if (/复查|复诊|监测|随访/.test(content)) reasons.push('医嘱新增复查/监测要求，需替代原随访安排');
  if (reasons.length === 0) return [];
  return agg.tasks
    .filter(
      (t) =>
        t.type === 'routine_followup' &&
        (t.status === 'scheduled' || t.status === 'frozen') &&
        +new Date(t.dueAt) >= +new Date(effectiveAt),
    )
    .map((task) => ({ task, reason: reasons.join('；') }));
}

export function doctorAddOrder(
  state: SystemState, patientId: string, actor: Actor, input: AddOrderInput, now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): AddOrderResult {
  requireRole(actor, ['doctor'], '补充医嘱');
  const orderId = uid('ord');
  const result: AddOrderResult = {
    events: [], orderId, backdated: false,
    conflicts: detectOrderConflicts(state, patientId, input.content, input.effectiveAt),
    interactions: [],
  };
  const events = commit(state, patientId, () => {
    const patient = state.patients.find((p) => p.id === patientId)!;
    const agg = project(state, patientId);
    // 补录判定：业务时间早于该任务上已有的护士记录（仅标记，时间线以业务时间排序）
    const latestNurseRecord = agg.reports
      .map((r) => +new Date(r.occurredAt))
      .concat(agg.tasks.filter((t) => t.type === 'escalation').map((t) => +new Date(t.createdAt)))
      .reduce((a, b) => Math.max(a, b), 0);
    const backdated = +new Date(input.effectiveAt) < latestNurseRecord;
    result.backdated = backdated;
    result.interactions = detectInteractions(patient, [input.content]);

    const out: NewEvent[] = [{
      type: 'order_added', patientId, occurredAt: input.effectiveAt,
      actorId: actor.id, actorRole: actor.role,
      payload: { orderId, content: input.content, backdated },
    }];

    // 与既有计划冲突 → 旧任务明确取消并建立替代关系（不删除）
    const chosen = (input.supersedeTaskIds ?? []).length > 0
      ? input.supersedeTaskIds!
      : result.conflicts.map((c) => c.task.id);
    if (chosen.length > 0) {
      const newTasks: FollowUpTask[] = [];
      const replacementById: Record<string, string> = {};
      for (const oldId of chosen) {
        const due = input.replacementDueAt?.[oldId];
        if (due) {
          const nt: FollowUpTask = {
            id: uid('task'), patientId, type: 'routine_followup',
            title: `替代随访（依据医嘱：${input.content.slice(0, 12)}…）`,
            level: 'L2', status: 'scheduled', dueAt: due, createdAt: now,
          };
          newTasks.push(nt);
          replacementById[oldId] = nt.id;
        }
      }
      out.push({
        type: 'plan_superseded', patientId, occurredAt: now,
        actorId: actor.id, actorRole: actor.role,
        payload: {
          orderId, orderContent: input.content,
          conflict: result.conflicts.find((c) => chosen.includes(c.task.id))?.reason ?? '医嘱与既有随访计划冲突',
          oldTaskIds: chosen, newTasks, replacementById,
        },
      });
      for (const nt of newTasks) out.push(makeTask(nt));
    }

    // 用药相互作用 → 通知药师复核（药师只能给建议，不能改诊疗结论）
    if (result.interactions.length > 0) {
      notify(state, out, patientId, now, 'role:pharmacist',
        `新医嘱需用药复核：${result.interactions.map((i) => i.pair).join('、')}`);
    }
    return out;
  }, now, opts);
  result.events = events;
  return result;
}

// ============ 命令 7：医生撤回错误医嘱（不覆盖原始记录） ============
export function withdrawOrder(
  state: SystemState, patientId: string, orderId: string,
  actor: Actor, reason: string, now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): BaseEvent[] {
  requireRole(actor, ['doctor'], '撤回医嘱');
  return commit(state, patientId, () => {
    const agg = project(state, patientId);
    const order = agg.orders.find((o) => o.id === orderId);
    if (!order) throw new DomainError('ORDER_NOT_FOUND', '医嘱不存在');
    if (order.status === 'withdrawn') throw new DomainError('ORDER_WITHDRAWN', '医嘱已撤回，不能重复撤回');

    const out: NewEvent[] = [{
      type: 'order_withdrawn', patientId, occurredAt: now,
      actorId: actor.id, actorRole: actor.role,
      payload: { orderId, reason },
    }];

    // 找到因该医嘱被取消的常规任务 → 为每一个新建恢复性随访（旧取消记录保留）
    const supersedeEvt = state.events.find(
      (e) => e.patientId === patientId && e.type === 'plan_superseded' && e.payload.orderId === orderId,
    );
    if (supersedeEvt) {
      const oldIds = (supersedeEvt.payload.oldTaskIds as string[]) ?? [];
      const restoreTasks: FollowUpTask[] = oldIds.map((oldId) => ({
        id: uid('task'), patientId, type: 'routine_followup',
        title: `恢复随访（错误医嘱 ${orderId} 已撤回，原计划恢复）`,
        level: 'L2', status: 'scheduled',
        dueAt: new Date(+new Date(now) + 24 * 3600_000).toISOString(),
        createdAt: now,
        supersededBy: { eventId: supersedeEvt.id, reason: `恢复自被错误医嘱取消的任务 ${oldId}` },
      }));
      supersedeEvt.payload.restoreTaskIds = restoreTasks.map((t) => t.id);
      const payload = { orderId, reason, restoreTasks };
      out[0] = { ...out[0], payload };
      for (const nt of restoreTasks) out.push(makeTask(nt));
    }
    return out;
  }, now, opts);
}

// ============ 命令 8：药师用药复核（仅相互作用/建议） ============
export function pharmacistAdvice(
  state: SystemState, patientId: string, actor: Actor,
  input: { taskId?: string; interaction: string; advice: string; severity: PharmacyAdvice['severity'] },
  now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): BaseEvent[] {
  requireRole(actor, ['pharmacist'], '用药复核');
  return commit(state, patientId, () => [{
    type: 'pharmacy_review', patientId, taskId: input.taskId, occurredAt: now,
    actorId: actor.id, actorRole: actor.role,
    payload: { adviceId: uid('adv'), taskId: input.taskId, interaction: input.interaction, advice: input.advice, severity: input.severity },
  }], now, opts);
}

// ============ 命令 9：人工队列处置（护士） ============
export function resolveManualQueue(
  state: SystemState, patientId: string, taskId: string,
  actor: Actor, note: string, now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): BaseEvent[] {
  requireRole(actor, ['nurse'], '人工队列处置');
  return commit(state, patientId, () => {
    const agg = project(state, patientId);
    const task = agg.tasks.find((t) => t.id === taskId);
    if (!task || task.type !== 'manual_queue') throw new DomainError('TASK_NOT_FOUND', '人工队列任务不存在');
    if (task.status === 'done') throw new DomainError('TASK_CLOSED', '任务已关闭');
    return [
      {
        type: 'note_added', patientId, taskId, occurredAt: now,
        actorId: actor.id, actorRole: actor.role, payload: { text: `人工处置：${note}` },
      },
      {
        type: 'task_status_changed', patientId, taskId, occurredAt: now,
        actorId: actor.id, actorRole: actor.role,
        payload: { taskId, status: 'done', reason: `人工处置完成：${note}` },
      },
    ];
  }, now, opts);
}

// ============ 命令 10：闭环关闭（必须填写关闭依据；转诊未确认禁关） ============
export function closeCase(
  state: SystemState, patientId: string, taskId: string,
  actor: Actor, basis: string, now: string,
  opts: { commandId?: string; expectedVersion?: number } = {},
): BaseEvent[] {
  requireRole(actor, ['nurse', 'doctor'], '事件闭环');
  if (!basis.trim()) throw new DomainError('BASIS_REQUIRED', '必须填写关闭依据');
  return commit(state, patientId, () => {
    const agg = project(state, patientId);
    const task = agg.tasks.find((t) => t.id === taskId);
    if (!task) throw new DomainError('TASK_NOT_FOUND', '任务不存在');
    if (task.status === 'done') throw new DomainError('TASK_CLOSED', '任务已关闭，不能重复关闭');
    if (task.status === 'cancelled') throw new DomainError('TASK_CANCELLED', '任务已取消');
    const pendingRef = agg.referrals.find(
      (r) => r.taskId === taskId && r.status === 'requested',
    );
    if (pendingRef) {
      throw new DomainError('REFERRAL_PENDING', '转诊尚未确认/驳回，不能闭环关闭（等待转诊结果或先处理恶化补充）');
    }
    const out: NewEvent[] = [{
      type: 'case_closed', patientId, taskId, occurredAt: now,
      actorId: actor.id, actorRole: actor.role, payload: { basis },
    }];
    // 升级事件闭环后解冻普通自动随访（取消的不恢复；每条解冻都有明确状态变更事件）
    if (task.type === 'escalation') {
      for (const rt of agg.tasks) {
        if (rt.type === 'routine_followup' && rt.status === 'frozen') {
          out.push({
            type: 'task_status_changed', patientId, taskId: rt.id, occurredAt: now,
            actorId: 'system', actorRole: 'system',
            payload: { taskId: rt.id, status: 'scheduled', reason: `升级事件 ${taskId} 已闭环，常规随访自动解冻` },
          });
        }
      }
    }
    return out;
  }, now, opts);
}

// ============ 系统轮询：SLA 超时持续提醒 ============
export function tickSla(state: SystemState, now: string): BaseEvent[] {
  const out: BaseEvent[] = [];
  for (const patient of state.patients) {
    const agg = project(state, patient.id);
    const open = agg.tasks.filter(
      (t) => (t.type === 'escalation' || t.type === 'manual_queue') &&
        (t.status === 'open' || t.status === 'in_progress'),
    );
    for (const task of open) {
      if (+new Date(now) <= +new Date(task.dueAt)) continue;
      // 节流：同一任务每模拟小时至多产生一条新提醒（避免轮询产生事件风暴），仍保持“持续提醒”
      const lastAt = agg.reminders
        .filter((r) => r.taskId === task.id)
        .reduce((mx, r) => Math.max(mx, +new Date(r.at)), 0);
      if (lastAt && +new Date(now) - lastAt < 3600_000) continue;
      const count = agg.reminders.filter((r) => r.taskId === task.id).length + 1;
      const evts = commit(state, patient.id, () => [{
        type: 'sla_reminder', patientId: patient.id, taskId: task.id, occurredAt: now,
        actorId: 'system', actorRole: 'system', payload: { count },
      }, {
        type: 'notification_sent', patientId: patient.id, occurredAt: now,
        actorId: 'system', actorRole: 'system',
        payload: {
          channel: 'app_push', target: 'role:nurse',
          purpose: `⚠️ 超时未闭环提醒（第 ${count} 次）：${task.title}`,
          status: 'success',
        },
      }], now);
      out.push(...evts);
    }
  }
  return out;
}

// ============ outbox 通知重试 ============
export function retryNotification(state: SystemState, notificationEventId: string, now: string): BaseEvent[] {
  const failed = state.events.find((e) => e.id === notificationEventId && e.type === 'notification_sent');
  if (!failed) throw new DomainError('NOT_FOUND', '通知记录不存在');
  if (failed.payload.status !== 'failed') throw new DomainError('NOT_FAILED', '该通知无需重试');
  return commit(state, failed.patientId, () => [{
    type: 'notification_sent', patientId: failed.patientId, occurredAt: now,
    actorId: 'system', actorRole: 'system',
    payload: {
      channel: failed.payload.channel, target: failed.payload.target,
      purpose: `[重试] ${failed.payload.purpose}`,
      status: state.notifyChannelDown ? 'failed' : 'success',
      failReason: state.notifyChannelDown ? '通道仍不可用' : undefined,
      retriedEventId: notificationEventId,
    },
  }], now);
}

// ============ 时间线（按业务时间排序，记录时间并列展示） ============
export interface TimelineItem {
  event: BaseEvent;
  label: string;
  detail: string;
  tone: 'system' | 'patient' | 'nurse' | 'doctor' | 'pharmacist';
}

const EVENT_LABEL: Record<EventType, string> = {
  followup_plan_generated: '生成分级随访计划',
  task_created: '任务创建',
  task_status_changed: '任务状态变更',
  patient_reported: '患者上报',
  risk_escalated: '高风险升级',
  manual_queued: '转入人工队列',
  consent_declined: '患者拒绝联系',
  consent_expired: '授权过期',
  image_unreadable: '图片无法读取',
  nurse_screened: '护士初筛',
  phone_logged: '电话回访',
  er_advised: '急诊建议',
  referral_requested: '转诊申请',
  referral_confirmed: '转诊确认',
  referral_rejected: '转诊驳回',
  order_added: '补充医嘱',
  order_withdrawn: '撤回医嘱',
  plan_superseded: '计划冲突·取消替代',
  pharmacy_review: '药师用药复核',
  case_closed: '闭环关闭',
  case_reopened: '事件重开',
  sla_reminder: 'SLA 超时提醒',
  notification_sent: '异步通知',
  note_added: '处理备注',
};

export function buildTimeline(state: SystemState, patientId: string, viewerRole: Role | 'system' = 'system'): TimelineItem[] {
  const maskVitals = viewerRole === 'pharmacist';
  return state.events
    .filter((e) => e.patientId === patientId)
    .sort((a, b) =>
      +new Date(a.occurredAt) - +new Date(b.occurredAt) || a.version - b.version,
    )
    .map((e) => {
      const p = e.payload;
      let detail = '';
      switch (e.type) {
        case 'patient_reported':
          detail = maskVitals
            ? `${(p.symptoms as string[])?.join('、') || '无症状'}；用药依从 ${p.adherence}${p.duplicateOf ? '；【判重】与既有上报内容一致，标记为重复' : ''}${p.escalationId ? '；已挂接升级任务' : ''}（体温/血压/图片按授权对药师不可见）`
            : `${(p.symptoms as string[])?.join('、') || '无症状'}；体温 ${p.temperature ?? '—'}℃；血压 ${p.systolic ?? '—'}/${p.diastolic ?? '—'}；依从 ${p.adherence}${p.duplicateOf ? '；【判重】与既有上报内容一致，标记为重复' : ''}${p.escalationId ? '；已挂接升级任务' : ''}`;
          break;
        case 'risk_escalated':
          detail = `${p.summary}；时限 ${new Date(String(p.dueAt)).toLocaleString('zh-CN')}`;
          break;
        case 'task_status_changed':
          detail = `任务 → ${p.status}${p.reason ? `（${p.reason}）` : ''}`;
          break;
        case 'nurse_screened':
          detail = `初筛决定：${p.decision === 'phone_callback' ? '电话回访' : p.decision === 'er_advice' ? '急诊建议' : '转诊申请'}`;
          break;
        case 'phone_logged':
          detail = `${p.reached ? '已联系' : '未联系上'}：${p.note}`;
          break;
        case 'er_advised':
          detail = String(p.note);
          break;
        case 'referral_requested':
          detail = `申请转诊至「${p.targetDept}」：${p.reason}（唯一性校验通过）`;
          break;
        case 'referral_confirmed':
          detail = `转诊已确认：${p.note ?? ''}`;
          break;
        case 'referral_rejected':
          detail = `转诊驳回：${p.reason}`;
          break;
        case 'order_added':
          detail = `${p.content}${p.backdated ? '；【补录】业务时间早于护士记录，时间线按业务时间排列' : ''}`;
          break;
        case 'order_withdrawn':
          detail = `撤回医嘱：${p.reason}（原始医嘱保留为“已撤回”，未被覆盖）`;
          break;
        case 'plan_superseded':
          detail = `${p.conflict}；取消 ${(p.oldTaskIds as string[])?.length ?? 0} 个旧任务并建立替代关系`;
          break;
        case 'pharmacy_review':
          detail = `[${p.severity}] ${p.interaction} → 建议：${p.advice}（不改变诊疗结论）`;
          break;
        case 'case_closed':
          detail = `关闭依据：${p.basis}`;
          break;
        case 'case_reopened':
          detail = String(p.reason ?? '再次上报恶化，事件重开');
          break;
        case 'sla_reminder':
          detail = `第 ${p.count} 次持续提醒：超过时限仍未闭环`;
          break;
        case 'notification_sent':
          detail = `${p.purpose} → ${p.target}：${p.status === 'success' ? '发送成功' : `失败（${p.failReason}）`}`;
          break;
        case 'manual_queued':
          detail = `原因：${p.reason}`;
          break;
        case 'note_added':
          detail = String(p.text ?? '');
          break;
        case 'consent_declined':
          detail = `原因：${p.reason ?? '患者拒绝'}`;
          break;
        case 'consent_expired':
          detail = `授权有效期至 ${p.validUntil}`;
          break;
        case 'image_unreadable':
          detail = `无法读取的图片：${(p.imageIds as string[])?.join('、')}`;
          break;
        case 'followup_plan_generated':
          detail = `分级 ${p.level}；依据：${(p.reasons as string[])?.join('；')}；排期：出院第 ${(p.scheduleDays as number[])?.join('、')} 天`;
          break;
        case 'task_created':
          detail = `${(p.task as FollowUpTask).title}；时限 ${new Date((p.task as FollowUpTask).dueAt).toLocaleString('zh-CN')}`;
          break;
      }
      const tone = e.actorRole === 'system'
        ? 'system'
        : (e.actorRole as TimelineItem['tone']);
      return { event: e, label: EVENT_LABEL[e.type], detail, tone };
    });
}
