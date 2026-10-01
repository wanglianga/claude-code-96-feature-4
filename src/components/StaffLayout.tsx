import React, { useMemo } from 'react';
import { useStore } from '../store';
import { Badge } from './common';
import { fmt, LEVEL_LABEL } from '../rules';
import type { PatientAggregate } from '../types';

export const StaffLayout: React.FC<React.PropsWithChildren<{ title: string }>> = ({ title, children }) => {
  const store = useStore();
  const now = store.now();

  const rows = useMemo(() => store.aggregates().map(({ patientId, patient: agg }) => {
    const openEsc = agg.tasks.find((t) => t.type === 'escalation' && (t.status === 'open' || t.status === 'in_progress'));
    const overdue = agg.tasks.filter((t) => (t.status === 'open' || t.status === 'in_progress') && +new Date(t.dueAt) < +now);
    const queues = agg.tasks.filter((t) => t.type === 'manual_queue' && (t.status === 'open' || t.status === 'in_progress'));
    const pendingRef = agg.referrals.find((r) => r.status === 'requested');
    const consentExpired = +now > +new Date(agg.patient.consent.validUntil);
    return { patientId, agg, openEsc, overdue, queues, pendingRef, consentExpired };
  }), [store.state.events.length, now.getTime()]);

  const totalOverdue = rows.reduce((n, r) => n + r.overdue.length, 0);

  return (
    <div className="workspace">
      <div className="sidebar">
        <div className="small muted" style={{ padding: '2px 4px 8px' }}>
          {title} · 共 {rows.length} 名在管患者
        </div>
        {totalOverdue > 0 && (
          <div className="demo-banner danger" style={{ marginBottom: 10 }}>
            ⚠ 当前 {totalOverdue} 个任务超过时限未闭环，系统已持续提醒（SLA 扫描随“推进时间”或手动触发）。
          </div>
        )}
        {rows.map((r) => (
          <div
            key={r.patientId}
            className={`patient-item ${store.activePatientId === r.patientId ? 'active' : ''}`}
            onClick={() => store.setActivePatient(r.patientId)}
          >
            <div className="pname">
              {r.agg.patient.name}
              <span className="muted small">{r.agg.patient.gender}/{r.agg.patient.age}岁</span>
              <Badge tone="blue">{LEVEL_LABEL[(r.agg.tasks.find((t) => t.type !== 'manual_queue')?.level) ?? 'L1']}</Badge>
            </div>
            <div className="pmeta">{r.agg.patient.surgeryType} · 出院 {fmt(r.agg.patient.dischargeDate).slice(0, 10)}</div>
            <div className="flags">
              {r.openEsc && <Badge tone="red">高风险{openLabel(r.openEsc.status)}</Badge>}
              {r.overdue.length > 0 && <Badge tone="red" outline>超时×{r.overdue.length}</Badge>}
              {r.pendingRef && <Badge tone="amber">转诊待确认{r.pendingRef.pendingNotes.length > 0 ? `·恶化×${r.pendingRef.pendingNotes.length}` : ''}</Badge>}
              {r.queues.length > 0 && <Badge tone="amber">人工队列×{r.queues.length}</Badge>}
              {r.consentExpired && <Badge tone="purple" outline>授权过期</Badge>}
              {r.agg.patient.consent.declinedContact && <Badge tone="purple" outline>拒绝联系</Badge>}
            </div>
          </div>
        ))}
      </div>
      <div className="main-col">{children}</div>
    </div>
  );
};

function openLabel(status: string): string {
  return status === 'in_progress' ? '·处理中' : '·待处理';
}

export const Tabs: React.FC<{ tabs: { key: string; label: string; badge?: React.ReactNode }[]; active: string; onChange: (k: string) => void }> = ({ tabs, active, onChange }) => (
  <div className="tabs">
    {tabs.map((t) => (
      <div key={t.key} className={`tab ${active === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
        {t.label} {t.badge}
      </div>
    ))}
  </div>
);

export type PatientRow = {
  patientId: string;
  agg: PatientAggregate;
  openEsc?: ReturnType<PatientAggregate['tasks']['find']>;
  overdue: PatientAggregate['tasks'];
  queues: PatientAggregate['tasks'];
  pendingRef?: PatientAggregate['referrals'][number];
  consentExpired: boolean;
};
