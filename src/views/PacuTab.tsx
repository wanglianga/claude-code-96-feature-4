import { useState } from 'react'
import { useStore } from '../store'
import type { ProlongedReason } from '../types'
import { RECOVERY_LIMIT_MIN, fmtDur, fmtTime, isProlonged } from '../utils'
import { Card, Msg, StatusBadge } from '../components/common'

const REASONS: ProlongedReason[] = ['疼痛', '恶心呕吐', '无人接送', '医生仍需观察']

/** 复苏室：监测复苏时长，滞留原因登记（带入周转统计） */
export default function PacuTab() {
  const { patients, now, setProlongedReason } = useStore()
  const list = patients.filter((p) => p.status === 'recovery')
  const [reason, setReason] = useState<Record<string, ProlongedReason>>({})
  const [note, setNote] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)

  return (
    <div>
      <div className="muted" style={{ marginBottom: 8 }}>
        复苏观察阈值 {RECOVERY_LIMIT_MIN} 分钟，超时将提示登记滞留原因（疼痛 / 恶心呕吐 / 无人接送 / 医生仍需观察），原因自动带入当日手术周转统计。
      </div>
      {list.length === 0 && <div className="muted">复苏室暂无患者</div>}
      <Msg msg={msg} />
      {list.map((p) => {
        const elapsed = now - (p.recovery?.enteredAt ?? now)
        const prolonged = isProlonged(p, now)
        return (
          <Card
            key={p.id}
            title={`${p.name} · ${p.surgeryType}`}
            extra={<StatusBadge status={p.status} />}
          >
            <div className="kv">
              <span>入室复苏</span><b>{fmtTime(p.recovery?.enteredAt)}</b>
              <span>已观察</span>
              <b className={prolonged ? 'warn' : ''}>{fmtDur(elapsed)}{prolonged ? '（滞留）' : ''}</b>
              <span>接送人</span><b>{p.pickup.name}（{p.pickup.relation} · {p.pickup.phone}）</b>
            </div>
            {prolonged && !p.recovery?.prolongedReason && (
              <div className="alert">
                <b>⚠ 复苏滞留超过 {RECOVERY_LIMIT_MIN} 分钟，请登记原因：</b>
                <div className="inline-form">
                  <select
                    value={reason[p.id] ?? REASONS[0]}
                    onChange={(e) => setReason({ ...reason, [p.id]: e.target.value as ProlongedReason })}
                  >
                    {REASONS.map((r) => <option key={r}>{r}</option>)}
                  </select>
                  <input
                    placeholder="备注（可选）"
                    value={note[p.id] ?? ''}
                    onChange={(e) => setNote({ ...note, [p.id]: e.target.value })}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setProlongedReason(p.id, reason[p.id] ?? REASONS[0], (note[p.id] ?? '').trim())
                      setMsg(`已登记 ${p.name} 的滞留原因，并计入当日周转统计`)
                    }}
                  >
                    登记原因
                  </button>
                </div>
              </div>
            )}
            {p.recovery?.prolongedReason && (
              <div className="ok">
                滞留原因已登记：{p.recovery.prolongedReason}
                {p.recovery.prolongedNote ? `（${p.recovery.prolongedNote}）` : ''} · {p.recovery.prolongedBy}
              </div>
            )}
            <div className="muted">下一步：到「离院管理」录入离院前评估（疼痛评分 / 饮水进食 / 排尿 / 用药说明 / 复诊时间）。</div>
          </Card>
        )
      })}
    </div>
  )
}
