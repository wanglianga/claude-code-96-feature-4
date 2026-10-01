import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Card, PatientBanner, ReportCard, TaskBadge, Badge } from '../components/common';
import { StaffLayout, Tabs } from '../components/StaffLayout';
import Timeline from '../components/Timeline';
import { detectInteractions, fmt } from '../rules';
import type { PatientAggregate } from '../types';

const PharmacistView: React.FC = () => {
  const store = useStore();
  const pid = store.activePatientId;
  const agg = store.aggregate(pid);
  const [tab, setTab] = useState('review');

  return (
    <StaffLayout title="临床药师工作台">
      <PatientBanner agg={agg} role="pharmacist" />
      <div className="demo-banner warn">
        药师授权范围：仅处理<b>用药相互作用与用药建议</b>。页面已按规则脱敏——不可见患者电话/证件、体温血压、伤口图片与完整诊疗医嘱；药师出具的意见以独立事件保存，<b>不能修改医嘱或任何诊疗结论</b>。
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'review', label: '用药复核' },
          { key: 'reports', label: '上报（脱敏视图）' },
          { key: 'timeline', label: '追溯时间线（脱敏）' },
        ]}
      />

      {tab === 'review' && <ReviewTab agg={agg} />}
      {tab === 'reports' && (
        <Card title="患者上报（药师视图：生命体征/图片字段不展示）">
          {agg.reports.slice().reverse().map((r) => <ReportCard key={r.id} report={r} showSensitive={false} />)}
        </Card>
      )}
      {tab === 'timeline' && <Timeline state={store.state} patientId={pid} viewerRole="pharmacist" />}
    </StaffLayout>
  );
};

const ReviewTab: React.FC<{ agg: PatientAggregate }> = ({ agg }) => {
  const store = useStore();
  const pid = agg.patient.id;
  const [custom, setCustom] = useState('');
  const [advice, setAdvice] = useState('');
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('warning');
  const [pair, setPair] = useState('');

  // 自动扫描：长期用药计划 + 生效中医嘱
  const activeOrderContents = agg.orders.filter((o) => o.status === 'active').map((o) => o.content);
  const detected = useMemo(
    () => detectInteractions(agg.patient, activeOrderContents),
    [agg.patient.id, agg.orders.length],
  );
  const extraHit = useMemo(() => (custom.trim() ? detectInteractions(agg.patient, [...activeOrderContents, custom.trim()]) : []), [custom, agg.patient.id, agg.orders.length]);
  const allHits = [...detected, ...extraHit.filter((e) => !detected.some((d) => d.pair === e.pair))];

  return (
    <>
      <Card title="当前用药与自动相互作用扫描">
        <div className="small muted">长期用药计划：</div>
        <div style={{ margin: '4px 0 10px' }}>
          {agg.patient.medPlan.map((m) => (
            <span key={m.id} className="image-chip">{m.drug} {m.dose} · {m.frequency}</span>
          ))}
        </div>
        <div className="small muted">生效中医嘱中药品线索（药师可见用药相关部分）：</div>
        <div style={{ margin: '4px 0 10px' }}>
          {activeOrderContents.length === 0 && <span className="empty">无生效中医嘱</span>}
          {activeOrderContents.map((c, i) => <span key={i} className="image-chip">{c}</span>)}
        </div>
        {allHits.length === 0 && <div className="empty">未检出相互作用；可在下方手工登记复核意见。</div>}
        {allHits.map((h) => (
          <div key={h.pair} className={`report-box ${h.severity === 'critical' ? 'high' : 'medium'}`}>
            <div className="rtop">
              <Badge tone={h.severity === 'critical' ? 'red' : 'amber'}>{h.severity === 'critical' ? '严重相互作用' : '需注意'}</Badge>
              <b>{h.pair}</b>
            </div>
            <div className="small" style={{ marginTop: 4 }}>{h.detail}</div>
            <button className="btn small" style={{ marginTop: 6 }} onClick={() => { setPair(h.pair); setAdvice(h.detail); setSeverity(h.severity); }}>
              据此生成复核意见
            </button>
          </div>
        ))}
      </Card>

      <Card title="出具用药复核意见（仅建议，不触碰诊疗结论/医嘱）">
        <div className="field">
          <label>相互作用/用药问题</label>
          <input type="text" value={pair} onChange={(e) => setPair(e.target.value)} placeholder="如：华法林 + 布洛芬" />
        </div>
        <div className="field">
          <label>新增药品线索（可选，输入后即时扫描）</label>
          <input type="text" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="如：新增布洛芬缓释胶囊" />
        </div>
        <div className="field">
          <label>用药建议</label>
          <textarea value={advice} onChange={(e) => setAdvice(e.target.value)} placeholder="用药教育、监测建议、间隔服药建议等；不得写诊疗结论" />
        </div>
        <div className="field">
          <label>级别</label>
          <div className="chip-group">
            {([['info', '提示'], ['warning', '注意'], ['critical', '严重']] as const).map(([v, l]) => (
              <span key={v} className={`chip ${severity === v ? `on ${v === 'critical' ? 'high' : 'medium'}` : ''}`} onClick={() => setSeverity(v)}>{l}</span>
            ))}
          </div>
        </div>
        <button
          className="btn primary"
          disabled={!pair.trim() || !advice.trim()}
          onClick={() => {
            store.doPharmacyAdvice(pid, { interaction: pair.trim(), advice: advice.trim(), severity });
            setPair(''); setAdvice(''); setCustom('');
          }}
        >
          提交复核意见（独立事件，医嘱与任务均不会被修改）
        </button>
      </Card>

      <Card title="历史复核意见">
        {agg.advices.length === 0 && <div className="empty">暂无</div>}
        {agg.advices.slice().reverse().map((a) => (
          <div key={a.id} className="order-item">
            <div className="task-head">
              <Badge tone={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'amber' : 'blue'}>
                {a.severity === 'critical' ? '严重' : a.severity === 'warning' ? '注意' : '提示'}
              </Badge>
              <b>{a.interaction}</b>
              <span className="muted small">{fmt(a.createdAt)}</span>
            </div>
            <div className="small" style={{ marginTop: 4 }}>{a.advice}</div>
          </div>
        ))}
        <div className="divider" />
        <div className="small muted">
          权限验证：本页面不存在“修改医嘱/关闭事件/转诊”入口；若以药师身份直接调用相关命令，引擎角色守卫将返回 FORBIDDEN。
        </div>
      </Card>
    </>
  );
};

export default PharmacistView;
