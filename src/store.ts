import { create } from 'zustand';
import type { BaseEvent, User, Role, PatientAggregate } from './types';
import {
  SystemState, DomainError, project,
  submitReport, nurseScreen, resolveReferral, doctorAddOrder, withdrawOrder,
  pharmacistAdvice, resolveManualQueue, closeCase, declineContact,
  tickSla, retryNotification,
} from './engine';
import type { ReportInput, ScreenDecision, AddOrderInput } from './engine';
import { buildSeedState, SEED_USERS } from './seed';
import { uid } from './rules';

const STORAGE_KEY = 'followup-system-state-v1';
const SESSION_KEY = 'followup-system-session-v1';
const CLOCK_KEY = 'followup-system-clock-v1';

interface PersistShape {
  patients: SystemState['patients'];
  events: BaseEvent[];
  notifyChannelDown: boolean;
}

function loadState(): { state: SystemState; clockOffsetMin: number } {
  let clockOffsetMin = 0;
  try {
    clockOffsetMin = Number(localStorage.getItem(CLOCK_KEY) ?? '0') || 0;
  } catch { /* ignore */ }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as PersistShape;
      return {
        state: { patients: data.patients, users: SEED_USERS, events: data.events, notifyChannelDown: data.notifyChannelDown },
        clockOffsetMin,
      };
    }
  } catch { /* ignore */ }
  const state = buildSeedState(new Date());
  return { state, clockOffsetMin };
}

let initial: { state: SystemState; clockOffsetMin: number } | null = null;

export interface Toast {
  id: string;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

interface Store {
  state: SystemState;
  currentUser: User | null;
  clockOffsetMin: number;
  toasts: Toast[];
  activePatientId: string;

  now: () => Date;
  login: (loginName: string, password: string) => boolean;
  logout: () => void;
  setActivePatient: (id: string) => void;

  aggregates: () => { patient: PatientAggregate; patientId: string }[];
  aggregate: (id: string) => PatientAggregate;

  pushToast: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: string) => void;

  run: <T>(fn: () => T, okMsg?: string) => T | undefined;
  persist: () => void;
  resetDemo: () => void;

  setClockOffset: (min: number) => void;
  advanceClock: (min: number) => void;
  setChannelDown: (down: boolean) => void;

  doSubmitReport: (patientId: string, input: ReportInput) => ReturnType<typeof submitReport> | undefined;
  doDeclineContact: (patientId: string, reason: string) => void;
  doNurseScreen: (patientId: string, taskId: string, decision: ScreenDecision, expectedVersion: number) => void;
  doResolveReferral: (patientId: string, referralId: string, action: 'confirmed' | 'rejected', note: string) => void;
  doAddOrder: (patientId: string, input: AddOrderInput) => ReturnType<typeof doctorAddOrder> | undefined;
  doWithdrawOrder: (patientId: string, orderId: string, reason: string) => void;
  doPharmacyAdvice: (patientId: string, input: { taskId?: string; interaction: string; advice: string; severity: 'info' | 'warning' | 'critical' }) => void;
  doResolveQueue: (patientId: string, taskId: string, note: string) => void;
  doClose: (patientId: string, taskId: string, basis: string, expectedVersion: number) => void;
  doRetryNotification: (eventId: string) => void;
  doTickSla: () => number;
  lastReportCommandByPatient: Record<string, string>;
  doReplayLastReport: (patientId: string) => void;
}

export const useStore = create<Store>((set, get) => {
  if (!initial) initial = loadState();
  const persistNow = (state: SystemState, clockOffsetMin: number) => {
    try {
      const data: PersistShape = {
        patients: state.patients, events: state.events,
        notifyChannelDown: state.notifyChannelDown,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(CLOCK_KEY, String(clockOffsetMin));
    } catch { /* ignore */ }
  };

  let sessionUser: User | null = null;
  try {
    const sid = localStorage.getItem(SESSION_KEY);
    sessionUser = sid ? SEED_USERS.find((u) => u.id === sid) ?? null : null;
  } catch { /* ignore */ }

  return {
    state: initial.state,
    currentUser: sessionUser,
    clockOffsetMin: initial.clockOffsetMin,
    toasts: [],
    activePatientId: initial.state.patients[0].id,
    lastReportCommandByPatient: {},

    now: () => new Date(Date.now() + get().clockOffsetMin * 60_000),

    login: (loginName, password) => {
      const u = SEED_USERS.find((x) => x.login === loginName && x.password === password);
      if (!u) return false;
      set({ currentUser: u, activePatientId: u.patientId ?? get().state.patients[0].id });
      try { localStorage.setItem(SESSION_KEY, u.id); } catch { /* ignore */ }
      return true;
    },
    logout: () => {
      set({ currentUser: null });
      try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    },
    setActivePatient: (id) => set({ activePatientId: id }),

    aggregates: () => {
      const { state } = get();
      return state.patients.map((p) => ({ patientId: p.id, patient: project(state, p.id) }));
    },
    aggregate: (id) => project(get().state, id),

    pushToast: (kind, text) => {
      const t = { id: uid('toast'), kind, text };
      set((s) => ({ toasts: [...s.toasts, t] }));
      setTimeout(() => get().dismissToast(t.id), 6000);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

    run: (fn, okMsg) => {
      try {
        const r = fn();
        get().persist();
        if (okMsg) get().pushToast('ok', okMsg);
        return r;
      } catch (e) {
        if (e instanceof DomainError) {
          get().pushToast('error', `[${e.code}] ${e.message}`);
        } else {
          get().pushToast('error', (e as Error).message);
        }
        return undefined;
      }
    },
    persist: () => persistNow(get().state, get().clockOffsetMin),
    resetDemo: () => {
      const fresh = buildSeedState(new Date(Date.now() + get().clockOffsetMin * 60_000));
      set({ state: fresh });
      persistNow(fresh, get().clockOffsetMin);
      get().pushToast('info', '演示数据已重置为初始状态');
    },

    setClockOffset: (min) => {
      set({ clockOffsetMin: min });
      try { localStorage.setItem(CLOCK_KEY, String(min)); } catch { /* ignore */ }
    },
    advanceClock: (min) => {
      set((s) => ({ clockOffsetMin: s.clockOffsetMin + min }));
      try { localStorage.setItem(CLOCK_KEY, String(get().clockOffsetMin)); } catch { /* ignore */ }
      get().doTickSla();
    },
    setChannelDown: (down) => {
      set((s) => ({ state: { ...s.state, notifyChannelDown: down } }));
      get().persist();
      get().pushToast(down ? 'info' : 'ok', down ? '异步通知通道已置为故障（新通知将失败进入 outbox）' : '异步通知通道已恢复');
    },

    doSubmitReport: (patientId, input) => {
      const user = get().currentUser!;
      const commandId = uid('cmd');
      const r = get().run(() => submitReport(
        get().state, patientId, { id: user.id, role: user.role },
        input, get().now().toISOString(),
        { commandId, expectedVersion: get().aggregate(patientId).version },
      ));
      if (r) {
        set((s) => ({ lastReportCommandByPatient: { ...s.lastReportCommandByPatient, [patientId]: commandId } }));
        const parts: string[] = [];
        if (r.duplicate) parts.push('命中 2 小时判重窗口：已标记为重复上报，未重复建任务/排队');
        if (r.escalationTaskId) parts.push('触发高风险规则：普通自动随访已冻结，升级任务已创建');
        if (r.queued.length) parts.push(`转人工队列 ${r.queued.length} 项：${r.queued.map((q) => q.reason).join('；')}`);
        if (parts.length === 0) parts.push('上报已受理（低风险，随常规随访处理）');
        get().pushToast(r.duplicate ? 'info' : 'ok', parts.join('\n'));
      }
      return r;
    },
    doDeclineContact: (patientId, reason) => {
      const user = get().currentUser!;
      get().run(() => declineContact(
        get().state, patientId, { id: user.id, role: user.role }, reason, get().now().toISOString(),
        { commandId: uid('cmd'), expectedVersion: get().aggregate(patientId).version },
      ), '已记录“拒绝联系”，并转入人工队列');
    },
    doNurseScreen: (patientId, taskId, decision, expectedVersion) => {
      const user = get().currentUser!;
      get().run(() => nurseScreen(
        get().state, patientId, taskId, { id: user.id, role: user.role }, decision,
        get().now().toISOString(),
        { commandId: uid('cmd'), expectedVersion },
      ), decision.kind === 'referral_request' ? '初筛完成：转诊申请已提交（唯一性已校验）' : `初筛完成：${decision.kind === 'er_advice' ? '急诊建议已发出' : '电话回访已记录'}`);
    },
    doResolveReferral: (patientId, referralId, action, note) => {
      const user = get().currentUser!;
      get().run(() => resolveReferral(
        get().state, patientId, referralId, { id: user.id, role: user.role }, action, note,
        get().now().toISOString(),
        { commandId: uid('cmd'), expectedVersion: get().aggregate(patientId).version },
      ), action === 'confirmed' ? '转诊已确认' : '转诊已驳回');
    },
    doAddOrder: (patientId, input) => {
      const user = get().currentUser!;
      const r = get().run(() => doctorAddOrder(
        get().state, patientId, { id: user.id, role: user.role }, input,
        get().now().toISOString(),
        { commandId: uid('cmd'), expectedVersion: get().aggregate(patientId).version },
      ));
      if (r) {
        const parts: string[] = [`医嘱已追加（事件 #${r.events[0]?.version}）`];
        if (r.backdated) parts.push('该医嘱为补录（业务时间早于护士记录），时间线按业务时间展示并明确标注');
        if (r.conflicts.length) parts.push(`检测到与 ${r.conflicts.length} 个既有随访任务冲突，旧任务已取消并建立替代关系`);
        if (r.interactions.length) parts.push(`用药相互作用 ${r.interactions.length} 项，已通知药师复核`);
        get().pushToast('ok', parts.join('\n'));
      }
      return r;
    },
    doWithdrawOrder: (patientId, orderId, reason) => {
      const user = get().currentUser!;
      get().run(() => withdrawOrder(
        get().state, patientId, orderId, { id: user.id, role: user.role }, reason,
        get().now().toISOString(),
        { commandId: uid('cmd'), expectedVersion: get().aggregate(patientId).version },
      ), '医嘱已撤回：原始记录保留为“已撤回”，受影响计划以恢复性任务替代');
    },
    doPharmacyAdvice: (patientId, input) => {
      const user = get().currentUser!;
      get().run(() => pharmacistAdvice(
        get().state, patientId, { id: user.id, role: user.role }, input,
        get().now().toISOString(),
        { commandId: uid('cmd'), expectedVersion: get().aggregate(patientId).version },
      ), '用药复核意见已记录（未修改任何诊疗结论/医嘱）');
    },
    doResolveQueue: (patientId, taskId, note) => {
      const user = get().currentUser!;
      get().run(() => resolveManualQueue(
        get().state, patientId, taskId, { id: user.id, role: user.role }, note,
        get().now().toISOString(),
        { commandId: uid('cmd'), expectedVersion: get().aggregate(patientId).version },
      ), '人工队列任务已处置关闭');
    },
    doClose: (patientId, taskId, basis, expectedVersion) => {
      const user = get().currentUser!;
      get().run(() => closeCase(
        get().state, patientId, taskId, { id: user.id, role: user.role }, basis,
        get().now().toISOString(),
        { commandId: uid('cmd'), expectedVersion },
      ), '事件已闭环关闭（关闭依据已入时间线）');
    },
    doRetryNotification: (eventId) => {
      get().run(() => retryNotification(get().state, eventId, get().now().toISOString()), '通知已重新投递');
    },
    doTickSla: () => {
      const evts = tickSla(get().state, get().now().toISOString());
      if (evts.length) {
        get().persist();
        get().pushToast('error', `SLA 扫描：${evts.length / 2} 个任务仍超时未闭环，已生成持续提醒`);
      }
      return evts.length;
    },
    doReplayLastReport: (patientId) => {
      const cmd = get().lastReportCommandByPatient[patientId];
      if (!cmd) {
        get().pushToast('info', '本会话该患者尚无已成功的上报命令可重放（请先在患者页面提交一次）');
        return;
      }
      // 重放必须以患者本人身份（命令的原始提交者）
      const patientUser = get().state.users.find((u) => u.role === 'patient' && u.patientId === patientId)!;
      const before = get().state.events.length;
      const r = submitReport(
        get().state, patientId, { id: patientUser.id, role: 'patient' },
        { channel: 'mini_app', symptoms: ['发热'], adherence: 'unknown', imageIds: [], imagesReadable: true },
        get().now().toISOString(),
        { commandId: cmd },
      );
      const noop = r.events.length === 0 && get().state.events.length === before;
      get().pushToast(noop ? 'info' : 'error', noop
        ? '幂等生效：同一命令令牌重放被整体丢弃，未产生任何新事件/新任务/新通知'
        : '异常：重放产生了副作用');
    },
  };
});

export const ROLE_LABEL: Record<Role, string> = {
  patient: '患者（受限入口）',
  nurse: '随访护士',
  doctor: '主治医生',
  pharmacist: '临床药师',
};
