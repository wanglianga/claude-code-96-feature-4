import React from 'react';
import type { PatientAggregate, FollowUpTask, Report } from '../types';
import { useStore } from '../store';
import { fmt, maskPatient, RISK_LABEL, CHANNEL_LABEL } from '../rules';
import type { Role } from '../types';

export const Card: React.FC<React.PropsWithChildren<{ title?: React.ReactNode; extra?: React.ReactNode; className?: string }>> = ({ title, extra, children, className = '' }) => (
  <div className={`card ${className}`}>
    {(title || extra) && (
      <h3>
        <span style={{ flex: 1 }}>{title}</span>
        {extra}
      </h3>
    )}
    {children}
  </div>
);

export const Badge: React.FC<React.PropsWithChildren<{ tone: 'red' | 'amber' | 'green' | 'blue' | 'purple' | 'gray'; outline?: boolean }>> = ({ tone, outline, children }) => (
  <span className={`badge ${tone}${outline ? ' outline' : ''}`}>{children}</span>
);

export const TASK_STATUS_META: Record<string, { label: string; tone: 'red' | 'amber' | 'green' | 'blue' | 'purple' | 'gray' }> = {
  scheduled: { label: '已排期', tone: 'blue' },
  frozen: { label: '已冻结', tone: 'purple' },
  open: { label: '待处理', tone: 'red' },
  in_progress: { label: '处理中', tone: 'amber' },
  done: { label: '已完成', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' },
};

export const TaskBadge: React.FC<{ status: string }> = ({ status }) => {
  const m = TASK_STATUS_META[status] ?? { label: status, tone: 'gray' as const };
  return <Badge tone={m.tone}>{m.label}</Badge>;
};

export const riskTone = (r: Report['risk']): 'red' | 'amber' | 'green' =>
  r === 'high' ? 'red' : r === 'medium' ? 'amber' : 'green';

export const isOverdue = (t: FollowUpTask, now: Date): boolean =>
  (t.status === 'open' || t.status === 'in_progress') && +new Date(t.dueAt) < +now;

/** 患者信息横幅：按角色脱敏 */
export const PatientBanner: React.FC<{ agg: PatientAggregate; role: Role; self?: boolean }> = ({ agg, role, self }) => {
  const m = maskPatient(agg.patient, role, self);
  const consentExpired = +new Date(useStore.getState().now()) > +new Date(agg.patient.consent.validUntil);
  return (
    <Card
      title={
        <>
          {m.name}
          <Badge tone="blue">{agg.patient.surgeryType}</Badge>
          {agg.patient.consent.declinedContact && <Badge tone="amber">已拒绝联系</Badge>}
          {consentExpired && <Badge tone="red">授权已过期</Badge>}
        </>
      }
      extra={<span className="muted small">聚合版本 v{agg.version}</span>}
    >
      <div className="kv-grid">
        <div className="kv"><div className="k">性别 / 年龄</div><div className="v">{m.gender} / {m.age}{role === 'pharmacist' && <span className="masked-tag">部分脱敏</span>}</div></div>
        <div className="kv"><div className="k">联系电话</div><div className="v">{m.phone}{!['patient', 'nurse', 'doctor'].includes(role) && <span className="masked-tag">无权查看</span>}</div></div>
        <div className="kv"><div className="k">证件后四位</div><div className="v">{m.idCardLast4}{role === 'pharmacist' && <span className="masked-tag">无权查看</span>}</div></div>
        <div className="kv"><div className="k">出院日期</div><div className="v">{fmt(agg.patient.dischargeDate)}</div></div>
        <div className="kv"><div className="k">过敏史</div><div className="v">{m.allergiesText}</div></div>
        <div className="kv"><div className="k">用药计划</div><div className="v">{m.medPlanNames.join('、')}</div></div>
      </div>
      <div className="divider" />
      <div className="kv">
        <div className="k">出院医嘱{role === 'pharmacist' && <span className="masked-tag">药师无权查看完整诊疗医嘱</span>}</div>
        <div className="v">{m.dischargeOrders.map((o, i) => <div key={i}>· {o}</div>)}</div>
      </div>
    </Card>
  );
};

export const ReportCard: React.FC<{ report: Report; showSensitive: boolean }> = ({ report, showSensitive }) => (
  <div className={`report-box ${report.risk === 'high' ? 'high' : report.risk === 'medium' ? 'medium' : ''}`}>
    <div className="rtop">
      <b>{fmt(report.occurredAt)}</b>
      <Badge tone={riskTone(report.risk)}>{RISK_LABEL[report.risk]}</Badge>
      <span className="muted">{CHANNEL_LABEL[report.channel]}上报</span>
      {report.duplicateOf && <Badge tone="purple" outline>重复上报（已判重）</Badge>}
      {report.escalationId && (report.handled ? <Badge tone="green">已随升级闭环</Badge> : <Badge tone="red">挂接升级中</Badge>)}
    </div>
    <div className="small" style={{ marginTop: 5 }}>
      症状：{report.symptoms.length ? report.symptoms.join('、') : '无'}
      {showSensitive && <>
        {' · '}体温：{report.temperature ? `${report.temperature}℃` : '—'}
        {' · '}血压：{report.systolic ? `${report.systolic}/${report.diastolic} mmHg` : '—'}
      </>}
      {' · '}用药依从：{{ full: '完全依从', partial: '部分依从', none: '未依从', unknown: '未报告' }[report.adherence]}
    </div>
    {showSensitive && report.imageIds.length > 0 && (
      <div>
        {report.imageIds.map((img) => (
          <span key={img} className={`image-chip ${report.imageReadable ? '' : 'broken'}`}>
            {report.imageReadable ? '🖼' : '⚠️'} {img}{report.imageReadable ? '' : '（无法读取）'}
          </span>
        ))}
      </div>
    )}
    {showSensitive && report.note && <div className="small muted" style={{ marginTop: 4 }}>备注：{report.note}</div>}
    <div className="rules">命中规则：{report.triggeredRules.join('；')}</div>
    {!showSensitive && <div className="small" style={{ color: 'var(--purple)', marginTop: 3 }}>※ 当前角色按授权不可见体温/血压/图片字段</div>}
  </div>
);

export const Toasts: React.FC = () => {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="x" onClick={() => dismiss(t.id)}>✕</span>
          {t.text}
        </div>
      ))}
    </div>
  );
};
