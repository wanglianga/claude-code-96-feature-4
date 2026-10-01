import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Card, PatientBanner, ReportCard, TaskBadge, Badge, isOverdue } from '../components/common';
import { StaffLayout, Tabs } from '../components/StaffLayout';
import Timeline from '../components/Timeline';
import { fmt, detectInteractions } from '../rules';
import { detectOrderConflicts } from '../engine';
import type { FollowUpTask, PatientAggregate } from '../types';

const toLocalInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const DoctorView: React.FC = () => {
  const store = useStore();
  const pid = store.activePatientId;
  const agg = store.aggregate(pid);
  const now = store.now();
  const [tab, setTab] = useState('orders');

  const openEscalations = agg.tasks.filter((t) => t.type === 'escalation' && t.status !== 'done' && t.status !== 'cancelled');
  const pendingReferrals = agg.referrals.filter((r) => r.status === 'requested');

  return (
    <StaffLayout title="主治医生工作台">
      <PatientBanner agg={agg} role="doctor" />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'orders', label: '医嘱与计划冲突' },
          { key: 'referrals', label: `转诊确认${pendingReferrals.length ? ` (${pendingReferrals.length})` : ''}` },
          { key: 'cases', label: `升级事件${openEscalations.length ? ` (${openEscalations.length})` : ''}` },
          { key: 'reports', label: '上报明细' },
          { key: 'timeline', label: '追溯时间线' },
        ]}
      />

      {tab === 'orders' && <OrdersTab agg={agg} now={now} />}
      {tab === 'referrals' && <ReferralsTab agg={agg} />}
      {tab === 'cases' && <CasesTab agg={agg} now={now} />}
      {tab === 'reports' && (
        <Card title="患者上报（医生视图：全字段）">
          {agg.reports.slice().reverse().map((r) => <ReportCard key={r.id} report={r} showSensitive />)}
        </Card>
      )}
      {tab === 'timeline' && <Timeline state={store.state} patientId={pid} viewerRole="doctor" />}
    </StaffLayout>
  );
};

// ---------- 医嘱：补充（含补录与冲突替代）/ 撤回 ----------
const OrdersTab: React.FC<{ agg: PatientAggregate; now: Date }> = ({ agg, now }) => {
  const store = useStore();
  const pid = agg.patient.id;
  const [content, setContent] = useState('');
  const [effectiveAt, setEffectiveAt] = useState(toLocalInput(now));
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [replaceAt, setReplaceAt] = useState<Record<string, string>>({});
  const [withdrawId, setWithdrawId] = useState<string | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');

  const conflicts = useMemo(
    () => content.trim() && effectiveAt
      ? detectOrderConflicts(store.state, pid, content.trim(), new Date(effectiveAt).toISOString())
      : [],
    [content, effectiveAt, agg.version],
  );
  const liveInteractions = useMemo(
    () => (content.trim() ? detectInteractions(agg.patient, [content.trim()]) : []),
    [content, agg.patient.id],
  );

  // 补录预判：业务时间早于该患者最近一条护士/上报记录
  const latestCareTs = Math.max(
    ...agg.reports.map((r) => +new Date(r.occurredAt)),
    ...agg.tasks.filter((t) => t.type === 'escalation').map((t) => +new Date(t.createdAt)),
    0,
  );
  const willBackdate = !!effectiveAt && +new Date(effectiveAt) < latestCareTs;

  const submit = () => {
    const supersedeTaskIds = conflicts.map((c) => c.task.id).filter((id) => chosen[id] !== false);
    const replacementDueAt: Record<string, string> = {};
    for (const id of supersedeTaskIds) {
      if (replaceAt[id]) replacementDueAt[id] = new Date(replaceAt[id]).toISOString();
    }
    const r = store.doAddOrder(pid, {
      content: content.trim(),
      effectiveAt: new Date(effectiveAt).toISOString(),
      supersedeTaskIds: supersedeTaskIds.length ? supersedeTaskIds : undefined,
      replacementDueAt: Object.keys(replacementDueAt).length ? replacementDueAt : undefined,
    });
    if (r) {
      setContent(''); setChosen({}); setReplaceAt({});
    }
  };

  return (
    <>
      <Card title="补充医嘱（业务时间可早于当前——模拟补录）">
        <div className="field">
          <label>医嘱内容（含“停/换药/提前/复查”等词时将触发与既有随访计划的冲突检测）</label>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="如：即刻停用布洛芬，改对乙酰氨基酚；明日提前门诊复查凝血" />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>医嘱业务生效时间</label>
            <input type="datetime-local" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} />
            {willBackdate && (
              <div className="hint" style={{ color: 'var(--purple)', fontWeight: 600 }}>
                该时间早于已有护士/上报记录：保存后将明确标注为【补录】，时间线仍按业务时间排列，但不会覆盖任何原始记录。
              </div>
            )}
          </div>
          <div className="field">
            <label>系统记录时间</label>
            <input type="text" disabled value={fmt(now.toISOString())} />
            <div className="hint">记录时间恒为当前时刻，不可手工修改（审计依据）。</div>
          </div>
        </div>

        {liveInteractions.length > 0 && (
          <div className="report-box high">
            <b>用药相互作用预检：</b>
            {liveInteractions.map((i) => (
              <div key={i.pair} className="small">
                <Badge tone={i.severity === 'critical' ? 'red' : 'amber'}>{i.severity === 'critical' ? '严重' : '注意'}</Badge>
                {i.pair}：{i.detail}（保存后自动通知药师复核，药师只能出具建议）
              </div>
            ))}
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="field">
            <label>检测到与既有随访计划冲突（{conflicts.length} 项）——勾选后旧任务将被明确“取消”并可生成替代任务</label>
            {conflicts.map(({ task, reason }) => (
              <div key={task.id} className="conflict-row">
                <input
                  type="checkbox"
                  checked={chosen[task.id] !== false}
                  onChange={(e) => setChosen((c) => ({ ...c, [task.id]: e.target.checked }))}
                />
                <div style={{ flex: 1 }}>
                  <div><b>{task.title}</b> <TaskBadge status={task.status} /> · 原定 {fmt(task.dueAt)}</div>
                  <div className="muted small">冲突原因：{reason}</div>
                  <div className="small" style={{ marginTop: 3 }}>
                    替代随访时间（留空则仅取消，不补排）：
                    <input
                      type="datetime-local"
                      style={{ width: 220, marginLeft: 8 }}
                      value={replaceAt[task.id] ?? ''}
                      onChange={(e) => setReplaceAt((m) => ({ ...m, [task.id]: e.target.value }))}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <button className="btn primary" disabled={!content.trim() || !effectiveAt} onClick={submit}>
          追加医嘱事件
        </button>
      </Card>

      <Card title="医嘱记录（撤回只追加“撤回事件”，原始记录保留可追溯）">
        {agg.orders.length === 0 && <div className="empty">暂无医嘱</div>}
        {agg.orders.map((o) => (
          <div key={o.id} className={`order-item ${o.status === 'withdrawn' ? 'withdrawn' : ''}`}>
            <div className="task-head">
              <span className={o.status === 'withdrawn' ? 'ostrike' : ''}>{o.content}</span>
              <Badge tone={o.status === 'active' ? 'green' : 'gray'}>{o.status === 'active' ? '生效中' : '已撤回'}</Badge>
              {o.backdated && <span className="backdate-tag">【补录】业务时间 {fmt(o.orderedAt)}</span>}
            </div>
            <div className="task-meta">
              业务时间 {fmt(o.orderedAt)} · 记录时间 {fmt(o.recordedAt)} · 事件 v 见时间线
            </div>
            {o.status === 'withdrawn' && (
              <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>
                撤回原因：{o.withdrawReason}（撤回事件 {o.withdrawnByEventId}）
              </div>
            )}
            {o.status === 'active' && (
              <>
                {withdrawId !== o.id ? (
                  <button className="btn small danger" style={{ marginTop: 6 }} onClick={() => { setWithdrawId(o.id); setWithdrawReason(''); }}>
                    撤回该错误医嘱
                  </button>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <div className="field">
                      <textarea value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} placeholder="撤回原因（必填，进入时间线）。被该医嘱取消的随访将自动生成恢复性任务，旧取消记录仍保留。" />
                    </div>
                    <div className="btn-row">
                      <button className="btn danger small" disabled={!withdrawReason.trim()} onClick={() => { store.doWithdrawOrder(pid, o.id, withdrawReason.trim()); setWithdrawId(null); }}>
                        确认撤回
                      </button>
                      <button className="btn small" onClick={() => setWithdrawId(null)}>取消</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        <div className="divider" />
        <h4>随访任务的取消 / 替代 / 恢复关系</h4>
        {agg.tasks.filter((t) => t.type === 'routine_followup').map((t) => (
          <div key={t.id} className="conflict-row">
            <span style={{ flex: 1 }}>
              <b>{t.title}</b> · {fmt(t.dueAt)} <TaskBadge status={t.status} />
              {t.supersededBy && <div className="small" style={{ color: 'var(--purple)' }}>↳ {t.supersededBy.reason}{t.supersededBy.newTaskId ? ` · 替代任务 ${t.supersededBy.newTaskId}` : ''}</div>}
            </span>
          </div>
        ))}
      </Card>
    </>
  );
};

// ---------- 转诊确认/驳回 ----------
const ReferralsTab: React.FC<{ agg: PatientAggregate }> = ({ agg }) => {
  const store = useStore();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const all = agg.referrals;
  return (
    <Card title="转诊审批（仅医生可确认/驳回；待确认期间的恶化补充挂接在原单）">
      {all.length === 0 && <div className="empty">暂无转诊申请</div>}
      {all.map((r) => (
        <div key={r.id} className="ref-card" style={{ borderStyle: 'solid' }}>
          <div className="task-head">
            <b>转诊单 {r.id}</b>
            <Badge tone={r.status === 'confirmed' ? 'green' : r.status === 'rejected' ? 'gray' : 'amber'}>
              {{ requested: '待确认', confirmed: '已确认', rejected: '已驳回', cancelled: '已取消' }[r.status]}
            </Badge>
            <span className="muted small">→ {r.targetDept} · 申请 {fmt(r.requestedAt)}</span>
          </div>
          <div className="small" style={{ marginTop: 5 }}>理由：{r.reason}</div>
          {r.pendingNotes.map((n, i) => (
            <div key={i} className="pending-note">
              ⚠ 确认前恶化补充（{fmt(n.at)}）：{n.text}
            </div>
          ))}
          {r.status === 'requested' && (
            <div style={{ marginTop: 8 }}>
              <div className="field">
                <textarea value={notes[r.id] ?? ''} onChange={(e) => setNotes((m) => ({ ...m, [r.id]: e.target.value }))} placeholder="确认/驳回意见（必填）" />
              </div>
              <div className="btn-row">
                <button className="btn primary small" disabled={!(notes[r.id] ?? '').trim()} onClick={() => { store.doResolveReferral(agg.patient.id, r.id, 'confirmed', notes[r.id].trim()); }}>
                  确认转诊
                </button>
                <button className="btn danger small" disabled={!(notes[r.id] ?? '').trim()} onClick={() => { store.doResolveReferral(agg.patient.id, r.id, 'rejected', notes[r.id].trim()); }}>
                  驳回
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
};

// ---------- 升级事件：医生视角补充医嘱后闭环 ----------
const CasesTab: React.FC<{ agg: PatientAggregate; now: Date }> = ({ agg, now }) => {
  const store = useStore();
  const [basis, setBasis] = useState<Record<string, string>>({});
  const tasks = agg.tasks.filter((t) => t.type === 'escalation');
  return (
    <>
      {tasks.length === 0 && <Card><div className="empty">暂无升级事件</div></Card>}
      {tasks.map((t) => {
        const closure = agg.closures.find((c) => c.taskId === t.id);
        const ref = agg.referrals.find((r) => r.taskId === t.id);
        const blocked = ref?.status === 'requested';
        return (
          <Card key={t.id} className="task-card high">
            <div className="task-head">
              <span className="task-title">{t.title}</span>
              <TaskBadge status={t.status} />
              {isOverdue(t, now) && <Badge tone="red">超时未闭环</Badge>}
            </div>
            <div className="task-meta">
              时限 {fmt(t.dueAt)}
              {ref && <> · 转诊状态：<b>{{ requested: '待确认（禁止闭环）', confirmed: '已确认', rejected: '已驳回', cancelled: '已取消' }[ref.status]}</b></>}
            </div>
            {closure && <div className="report-box" style={{ background: 'var(--green-soft)' }}>关闭依据（{fmt(closure.closedAt)}）：{closure.basis}</div>}
            {t.status !== 'done' && (
              <div style={{ marginTop: 8 }}>
                <div className="field">
                  <textarea value={basis[t.id] ?? ''} onChange={(e) => setBasis((m) => ({ ...m, [t.id]: e.target.value }))} placeholder="关闭依据（必填）：处置结论 + 转诊/急诊结果 + 复评安排" />
                </div>
                <button
                  className="btn primary small"
                  disabled={blocked || !(basis[t.id] ?? '').trim()}
                  title={blocked ? '转诊尚未确认，不能关闭' : ''}
                  onClick={() => store.doClose(agg.patient.id, t.id, basis[t.id].trim(), agg.version)}
                >
                  {blocked ? '转诊待确认，禁止闭环' : '医生闭环关闭'}
                </button>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
};

export default DoctorView;
