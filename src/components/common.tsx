import type { ReactNode } from 'react'
import type { Patient } from '../types'
import { EX_META, STATUS_META, feeSettled, fmtTime } from '../utils'

export function StatusBadge({ status }: { status: Patient['status'] }) {
  const m = STATUS_META[status]
  return (
    <span className="badge" style={{ background: `${m.color}1a`, color: m.color, borderColor: `${m.color}66` }}>
      {m.label}
    </span>
  )
}

export function FeeBadge({ p }: { p: Patient }) {
  if (feeSettled(p)) return <span className="badge badge-green">已结清</span>
  if (p.payment.paid > 0) return <span className="badge badge-amber">部分缴费</span>
  return <span className="badge badge-red">未缴费</span>
}

export function FlagBadges({ p }: { p: Patient }) {
  const open = p.exceptions.filter((e) => !e.resolved)
  return (
    <span className="flags">
      {p.assessment?.greenChannel && <span className="badge badge-green">绿色通道</span>}
      {p.delayedMin > 0 && <span className="badge badge-amber">延迟{p.delayedMin}分钟</span>}
      {open.map((e) => (
        <span key={e.id} className="badge badge-red" title={e.detail}>
          {EX_META[e.type].label}
        </span>
      ))}
    </span>
  )
}

export function Card({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h3>{title}</h3>
        <div>{extra}</div>
      </header>
      <div className="card-body">{children}</div>
    </section>
  )
}

export function Msg({ msg }: { msg: string | null }) {
  if (!msg) return null
  return <div className="msg">{msg}</div>
}

export function Timeline({ p, publicOnly }: { p: Patient; publicOnly?: boolean }) {
  const events = (publicOnly ? p.timeline.filter((e) => e.publicText) : p.timeline)
    .slice()
    .sort((a, b) => b.at - a.at)
  return (
    <ul className="timeline">
      {events.map((e) => (
        <li key={e.id} className={`tl-${e.kind}`}>
          <span className="tl-time">{fmtTime(e.at)}</span>
          <span className="tl-text">{publicOnly ? e.publicText : e.text}</span>
          {!publicOnly && <span className="tl-actor">{e.actor}</span>}
        </li>
      ))}
    </ul>
  )
}

export function ExceptionList({ p, onResolve }: { p: Patient; onResolve?: (exId: string) => void }) {
  if (!p.exceptions.length) return <div className="muted">暂无异常事件</div>
  return (
    <ul className="ex-list">
      {p.exceptions
        .slice()
        .sort((a, b) => b.at - a.at)
        .map((e) => (
          <li key={e.id} className={e.resolved ? 'ex resolved' : 'ex'}>
            <span className={`badge ${e.resolved ? 'badge-gray' : 'badge-red'}`}>{EX_META[e.type].label}</span>
            <span className="ex-detail">{e.detail}</span>
            <span className="muted">
              {fmtTime(e.at)} · {e.by}
            </span>
            {e.resolved ? (
              <span className="muted">已处理 {fmtTime(e.resolvedAt)}</span>
            ) : (
              onResolve && (
                <button className="btn btn-xs" onClick={() => onResolve(e.id)}>
                  标记处理
                </button>
              )
            )}
          </li>
        ))}
    </ul>
  )
}
