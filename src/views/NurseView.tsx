import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Card, PatientBanner, ReportCard, TaskBadge, Badge, isOverdue } from '../components/common';
import { StaffLayout, Tabs } from '../components/StaffLayout';
import Timeline from '../components/Timeline';
import { fmt } from '../rules';
import type { FollowUpTask, PatientAggregate } from '../types';

const NurseView: React.FC = () => {
  const store = useStore();
  const pid = store.activePatientId;
  const agg = store.aggregate(pid);
  const now = store.now();
  const [tab, setTab] = useState('tasks');

  const escalationTasks = agg.tasks.filter((t) => t.type === 'escalation');
  const queueTasks = agg.tasks.filter((t) => t.type === 'manual_queue');
  const failedNotifs = agg.notifications.filter((n) => n.status === 'failed');

  const counts = {
    tasks: escalationTasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length,
    queue: queueTasks.filter((t) => t.status !== 'done').length,
    outbox: failedNotifs.length,
  };

  return (
    <StaffLayout title="随访护士工作台">
      <PatientBanner agg={agg} role="nurse" />
      <SlaStrip agg={agg} now={now} />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'tasks', label: `升级任务${counts.tasks ? ` (${counts.tasks})` : ''}` },
          { key: 'queue', label: `人工队列${counts.queue ? ` (${counts.queue})` : ''}` },
          { key: 'outbox', label: `通知 Outbox${counts.outbox ? ` (${counts.outbox})` : ''}` },
          { key: 'timeline', label: '追溯时间线' },
        ]}
      />

      {tab === 'tasks' && (
        <>
          {escalationTasks.length === 0 && <Card><div className="empty">暂无高风险升级任务。高风险规则触发后，普通自动随访会先冻结，再在此生成升级任务。</div></Card>}
          {escalationTasks.map((t) => (
            <EscalationCard key={t.id} task={t} agg={agg} now={now} />
          ))}
          <Card title="并发与幂等试验台（验证不会重复转诊/重复处理）">
            <div className="section-sub">
              模拟真实风险：<b>角色并发操作</b>（两人基于旧页面同时提交，乐观锁拦截）、<b>重复提交</b>（同一命令令牌重放，服务端直接丢弃）。
            </div>
            <div className="btn-row">
              <button
                className="btn"
                disabled={!escalationTasks.some((t) => t.status === 'open' || t.status === 'in_progress')}
                onClick={() => {
                  const t = escalationTasks.find((x) => x.status === 'open' || x.status === 'in_progress')!;
                  // 故意用 0 号旧版本制造冲突
                  store.doNurseScreen(pid, t.id, {
                    kind: 'referral_request', reason: '并发窗口中的重复转诊申请（应被拦截）', targetDept: '心内科',
                  }, 0);
                }}
              >
                模拟并发：用过期版本号 v0 再申请一次转诊（期望被拒）
              </button>
              <button
                className="btn"
                onClick={() => store.doReplayLastReport(pid)}
              >
                重放该患者最近一次上报命令（同令牌，期望无效果）
              </button>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              先登录患者账号提交一次上报，再回护士页点“重放”。患者每次点击“提交”都会生成新令牌，因此双击/网络重试天然安全；这里用旧令牌演示服务端去重。
            </div>
          </Card>

          <Card title="患者上报（护士视图：含体温/血压/图片全字段）">
            {agg.reports.slice().reverse().map((r) => <ReportCard key={r.id} report={r} showSensitive />)}
          </Card>
        </>
      )}

      {tab === 'queue' && <QueueTab agg={agg} />}
      {tab === 'outbox' && <OutboxTab agg={agg} />}
      {tab === 'timeline' && <Timeline state={store.state} patientId={pid} viewerRole="nurse" />}
    </StaffLayout>
  );
};

// ---------- SLA 提醒条 ----------
const SlaStrip: React.FC<{ agg: PatientAggregate; now: Date }> = ({ agg, now }) => {
  const open = agg.tasks.filter((t) => (t.status === 'open' || t.status === 'in_progress') && +new Date(t.dueAt) < +now);
  const lastByTask = new Map<string, number>();
  for (const r of agg.reminders) lastByTask.set(r.taskId, Math.max(lastByTask.get(r.taskId) ?? 0, r.count));
  if (open.length === 0) return null;
  return (
    <Card>
      <div className="sla-strip">
        {open.map((t) => (
          <span key={t.id} className="sla-pill">
            ⏰ {t.type === 'escalation' ? '高风险升级' : '人工队列'}已超时 · 已提醒 {lastByTask.get(t.id) ?? 0} 次 · {t.title}
          </span>
        ))}
      </div>
    </Card>
  );
};

// ---------- 升级任务卡 ----------
const EscalationCard: React.FC<{
  task: FollowUpTask; agg: PatientAggregate; now: Date;
}> = ({ task, agg, now }) => {
  const store = useStore();
  const [mode, setMode] = useState<'none' | 'phone' | 'er' | 'referral' | 'close'>('none');
  const [phoneNote, setPhoneNote] = useState('');
  const [reached, setReached] = useState(true);
  const [erNote, setErNote] = useState('');
  const [refReason, setRefReason] = useState('');
  const [refDept, setRefDept] = useState('普外科急诊');
  const [basis, setBasis] = useState('');

  const referral = agg.referrals.find((r) => r.taskId === task.id);
  const closure = agg.closures.find((c) => c.taskId === task.id);
  const closed = task.status === 'done';
  const overdue = isOverdue(task, now);
  const canScreen = !closed && task.status !== 'cancelled';

  return (
    <Card className={`task-card high ${task.type}`}>
      <div className="task-head">
        <span className="task-title">{task.title}</span>
        <TaskBadge status={task.status} />
        {overdue && <Badge tone="red">已超时 {((+now - +new Date(task.dueAt)) / 3600_000).toFixed(1)}h</Badge>}
        <span className="muted small">时限：{fmt(task.dueAt)}</span>
      </div>
      <div className="task-meta">
        任务号 <span className="mono">{task.id}</span> · 创建 {fmt(task.createdAt)} · 初筛后可选择：电话回访 / 急诊建议 / 转诊申请
      </div>

      {referral && (
        <div className="ref-card">
          <div className="task-head">
            <b>转诊单 {referral.id}</b>
            <Badge tone={referral.status === 'confirmed' ? 'green' : referral.status === 'rejected' ? 'gray' : 'amber'}>
              {{ requested: '待医生确认（未闭环）', confirmed: '医生已确认', rejected: '医生已驳回', cancelled: '已取消' }[referral.status]}
            </Badge>
            <span className="muted small">→ {referral.targetDept} · {fmt(referral.requestedAt)}</span>
          </div>
          <div className="small" style={{ marginTop: 4 }}>转诊理由：{referral.reason}</div>
          {referral.status === 'rejected' && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>驳回原因：{referral.rejectReason}</div>}
          {referral.pendingNotes.map((n, i) => (
            <div key={i} className="pending-note">
              ⚠ {fmt(n.at)} 转诊确认前患者再次上报恶化（上报 {n.reportId}）：{n.text}
            </div>
          ))}
          {referral.status === 'requested' && (
            <div className="small" style={{ marginTop: 6, color: 'var(--amber)' }}>
              唯一性约束：该患者已有待确认转诊单，系统拒绝再次申请转诊；继续上报的恶化只会挂接本单。
            </div>
          )}
        </div>
      )}

      {closure && (
        <div className="report-box" style={{ background: 'var(--green-soft)' }}>
          <b>已闭环</b>（{fmt(closure.closedAt)}）· 关闭依据：{closure.basis}
        </div>
      )}

      {canScreen && (
        <>
          <div className="btn-row">
            <button className="btn" onClick={() => setMode(mode === 'phone' ? 'none' : 'phone')}>📞 电话回访</button>
            <button className="btn danger" onClick={() => setMode(mode === 'er' ? 'none' : 'er')}>🚑 急诊建议</button>
            <button className="btn primary" disabled={!!referral && referral.status === 'requested'} onClick={() => setMode(mode === 'referral' ? 'none' : 'referral')}>
              ↪ 转诊申请
            </button>
            <button className="btn" onClick={() => setMode(mode === 'close' ? 'none' : 'close')}>✓ 填写依据并闭环</button>
          </div>

          {mode === 'phone' && (
            <div style={{ marginTop: 10 }}>
              <div className="checkline">
                <input type="checkbox" id={`reach-${task.id}`} checked={reached} onChange={(e) => setReached(e.target.checked)} />
                <label htmlFor={`reach-${task.id}`} style={{ margin: 0 }}>已联系上患者</label>
              </div>
              <div className="field"><textarea value={phoneNote} onChange={(e) => setPhoneNote(e.target.value)} placeholder="电话回访记录（症状变化、指导内容）" /></div>
              <button className="btn primary small" disabled={!phoneNote.trim()} onClick={() => {
                store.doNurseScreen(agg.patient.id, task.id, { kind: 'phone_callback', note: phoneNote.trim(), reached }, agg.version);
                setPhoneNote(''); setMode('none');
              }}>提交回访记录</button>
            </div>
          )}
          {mode === 'er' && (
            <div style={{ marginTop: 10 }}>
              <div className="field"><textarea value={erNote} onChange={(e) => setErNote(e.target.value)} placeholder="急诊建议内容（将以短信异步通知患者；通知失败进入 outbox）" /></div>
              <button className="btn danger small" disabled={!erNote.trim()} onClick={() => {
                store.doNurseScreen(agg.patient.id, task.id, { kind: 'er_advice', note: erNote.trim() }, agg.version);
                setErNote(''); setMode('none');
              }}>发出急诊建议</button>
            </div>
          )}
          {mode === 'referral' && (
            <div style={{ marginTop: 10 }}>
              <div className="grid-2">
                <div className="field">
                  <label>目标科室</label>
                  <input type="text" value={refDept} onChange={(e) => setRefDept(e.target.value)} />
                </div>
                <div className="field">
                  <label>转诊理由</label>
                  <input type="text" value={refReason} onChange={(e) => setRefReason(e.target.value)} placeholder="如：术后活动性出血需外科评估" />
                </div>
              </div>
              <button className="btn primary small" disabled={!refReason.trim()} onClick={() => {
                store.doNurseScreen(agg.patient.id, task.id, { kind: 'referral_request', reason: refReason.trim(), targetDept: refDept.trim() }, agg.version);
                setRefReason(''); setMode('none');
              }}>提交转诊申请（医生确认后方可闭环）</button>
            </div>
          )}
          {mode === 'close' && (
            <div style={{ marginTop: 10 }}>
              <div className="field">
                <label>关闭依据（必填，进入永久时间线）</label>
                <textarea value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="如：电话回访确认症状缓解，急诊评估排除心梗，留观后返家，24h 后复评" />
              </div>
              <button className="btn primary small" disabled={!basis.trim()} onClick={() => {
                store.doClose(agg.patient.id, task.id, basis.trim(), agg.version);
                setBasis(''); setMode('none');
              }}>确认闭环</button>
              <div className="hint">转诊待确认、任务已取消等状态下系统将拒绝关闭。</div>
            </div>
          )}
        </>
      )}
    </Card>
  );
};

// ---------- 人工队列 ----------
const QueueTab: React.FC<{ agg: PatientAggregate }> = ({ agg }) => {
  const store = useStore();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const queues = agg.tasks.filter((t) => t.type === 'manual_queue');
  return (
    <>
      {queues.length === 0 && <Card><div className="empty">人工队列为空。患者拒绝联系、授权过期、图片无法读取、通知失败或中风险复核都会进入这里。</div></Card>}
      {queues.map((t) => (
        <Card key={t.id} className="task-card manual">
          <div className="task-head">
            <span className="task-title">{t.title}</span>
            <TaskBadge status={t.status} />
            {isOverdue(t, store.now()) && <Badge tone="red">超时未处置</Badge>}
          </div>
          <div className="task-meta">
            入队原因：{t.queueReason} · 时限 {fmt(t.dueAt)}
            {t.supersededBy && <span> · 取消/替代依据：{t.supersededBy.reason}</span>}
          </div>
          {t.status !== 'done' && t.status !== 'cancelled' && (
            <div style={{ marginTop: 8 }}>
              <div className="field">
                <textarea
                  value={notes[t.id] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [t.id]: e.target.value }))}
                  placeholder="人工处置记录（联系结果、重新获取图片、授权续期沟通等）"
                />
              </div>
              <button
                className="btn primary small"
                disabled={!(notes[t.id] ?? '').trim()}
                onClick={() => store.doResolveQueue(agg.patient.id, t.id, (notes[t.id] ?? '').trim())}
              >
                处置完成并关闭队列任务
              </button>
            </div>
          )}
        </Card>
      ))}
    </>
  );
};

// ---------- 通知 Outbox ----------
const OutboxTab: React.FC<{ agg: PatientAggregate }> = ({ agg }) => {
  const store = useStore();
  const list = useMemo(() => agg.notifications.slice().reverse(), [agg.notifications.length]);
  return (
    <Card title="异步通知发送记录（Outbox）">
      <div className="section-sub">
        主流程不依赖通知成功：通道故障时记录失败事件并把事项转入人工队列，恢复后可在此重试，保证不漏随访。
        可在顶部“故障模拟”开关切换通知通道状态。
      </div>
      {list.length === 0 && <div className="empty">暂无通知记录</div>}
      {list.map((n) => (
        <div key={n.eventId} className="report-box" style={{ background: n.status === 'success' ? 'var(--green-soft)' : 'var(--red-soft)' }}>
          <div className="rtop">
            <b>{n.status === 'success' ? '✓ 发送成功' : '✗ 发送失败'}</b>
            <span className="muted small">{fmt(n.at)}</span>
            <Badge tone={n.channel === 'sms' ? 'blue' : 'purple'}>{n.channel === 'sms' ? '短信' : 'App 推送'}</Badge>
          </div>
          <div className="small" style={{ marginTop: 4 }}>目标：{n.target} · 内容：{n.purpose}</div>
          {n.failReason && <div className="small" style={{ color: 'var(--red)' }}>失败原因：{n.failReason}</div>}
          {n.status === 'failed' && (
            <button className="btn small" style={{ marginTop: 6 }} onClick={() => store.doRetryNotification(n.eventId)}>
              重新投递
            </button>
          )}
        </div>
      ))}
    </Card>
  );
};

export default NurseView;
