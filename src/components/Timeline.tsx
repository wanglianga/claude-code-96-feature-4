import React, { useState } from 'react';
import type { SystemState } from '../engine';
import { buildTimeline } from '../engine';
import { fmt } from '../rules';
import { Badge } from './common';
import type { Role } from '../types';

const ACTOR_LABEL: Record<string, string> = {
  system: '系统',
  u_p1: '张建国（患者）', u_p2: '李秀兰（患者）', u_p3: '王桂芳（患者）',
  u_n1: '林梅（护士）', u_d1: '周岭（医生）', u_ph1: '陈越（药师）',
};

const TONE_LABEL: Record<string, string> = {
  system: '系统', patient: '患者', nurse: '护士', doctor: '医生', pharmacist: '药师',
};

export const Timeline: React.FC<{ state: SystemState; patientId: string; viewerRole?: Role | 'system' }> = ({ state, patientId, viewerRole = 'system' }) => {
  const items = buildTimeline(state, patientId, viewerRole);
  const [showRaw, setShowRaw] = useState(false);
  const [filter, setFilter] = useState<'all' | 'key'>('all');

  const keyTypes = new Set([
    'patient_reported', 'risk_escalated', 'nurse_screened', 'referral_requested',
    'referral_confirmed', 'referral_rejected', 'order_added', 'order_withdrawn',
    'plan_superseded', 'case_closed', 'case_reopened', 'sla_reminder', 'manual_queued',
  ]);
  const shown = filter === 'key' ? items.filter((i) => keyTypes.has(i.event.type)) : items;

  return (
    <div className="card">
      <h3>
        <span style={{ flex: 1 }}>事件时间线（仅追加，不可改写）</span>
        <button className="btn small" onClick={() => setFilter(filter === 'all' ? 'key' : 'all')}>
          {filter === 'all' ? '只看关键事件' : '显示全部事件'}
        </button>
        <button className="btn small" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? '隐藏原始载荷' : '查看原始载荷'}
        </button>
      </h3>
      <div className="section-sub">
        排序依据为 <b>业务发生时间（occurredAt）</b>；每条同时展示系统记录时间（recordedAt）——补录医嘱的业务时间可早于护士记录，撤回/改写只追加新事件，原始记录永不覆盖。事件版本号 v# 为写入顺序。
      </div>
      {shown.length === 0 && <div className="empty">暂无事件</div>}
      <div className="timeline">
        {shown.map((item) => {
          const e = item.event;
          const backdated = +new Date(e.occurredAt) < +new Date(e.recordedAt) - 60_000 &&
            !['notification_sent', 'sla_reminder', 'task_created', 'task_status_changed', 'followup_plan_generated'].includes(e.type);
          return (
            <div key={e.id} className={`tl-item ${item.tone}`}>
              <div className="tl-head">
                <span className="tl-label">{item.label}</span>
                <Badge tone={
                  item.tone === 'patient' ? 'blue' :
                  item.tone === 'nurse' ? 'green' :
                  item.tone === 'doctor' ? 'purple' :
                  item.tone === 'pharmacist' ? 'amber' : 'gray'
                }>{TONE_LABEL[item.tone]}</Badge>
                {e.commandId && <span className="mono" style={{ fontSize: 10.5, color: '#90a0b5' }}>幂等键 {e.commandId.slice(0, 10)}…</span>}
              </div>
              <div className="tl-detail">{item.detail}</div>
              <div>
                <span className="tl-time">业务时间：{fmt(e.occurredAt)}</span>
                <span className={`tl-recorded ${backdated ? 'backdated' : ''}`}>
                  {' · '}记录时间：{fmt(e.recordedAt)}
                  {backdated ? ' · 【补录】业务时间早于记录时间' : ''}
                </span>
                <span className="tl-actor"> · {ACTOR_LABEL[e.actorId] ?? e.actorId}</span>
                <span className="tl-ver"> · v{e.version}</span>
              </div>
              {showRaw && (
                <pre className="mono" style={{
                  margin: '6px 0 0', padding: 8, background: '#0f202b', color: '#cfe3ee',
                  borderRadius: 6, fontSize: 10.5, maxHeight: 180, overflow: 'auto',
                }}>
                  {JSON.stringify({ id: e.id, type: e.type, taskId: e.taskId, occurredAt: e.occurredAt, recordedAt: e.recordedAt, actorId: e.actorId, version: e.version, commandId: e.commandId, payload: e.payload }, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Timeline;
