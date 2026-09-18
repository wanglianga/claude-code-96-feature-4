import { useState } from 'react'
import { useStore } from '../store'
import { buildPostopNotes, feeSettled, fmtTime } from '../utils'
import { Card, FeeBadge, Msg, StatusBadge } from '../components/common'

/** 离院管理：离院前评估录入 → 待签收 → 已离院（注意事项 + 回访任务） */
export default function DischargeTab() {
  const { patients, saveDischarge } = useStore()
  const [selId, setSelId] = useState<string | null>(null)
  const [pain, setPain] = useState(2)
  const [oral, setOral] = useState(true)
  const [urine, setUrine] = useState(true)
  const [med, setMed] = useState(true)
  const [followup, setFollowup] = useState('2026-09-25')
  const [msg, setMsg] = useState<string | null>(null)

  const needEval = patients.filter((p) => p.status === 'recovery')
  const waitingSign = patients.filter((p) => p.status === 'ready_pickup')
  const discharged = patients.filter((p) => p.status === 'discharged')

  return (
    <div>
      <Card title={`离院前评估（复苏中 ${needEval.length} 人）`}>
        {needEval.length === 0 && <div className="muted">暂无待评估患者</div>}
        <div className="two-col">
          <ul className="pick-list">
            {needEval.map((p) => (
              <li key={p.id} className={p.id === selId ? 'active' : ''} onClick={() => { setSelId(p.id); setMsg(null) }}>
                <b>{p.name}</b> <span className="muted">{p.surgeryType}</span>
              </li>
            ))}
          </ul>
          {selId && needEval.some((p) => p.id === selId) && (
            <div className="form-grid">
              <label className="span2">疼痛评分（0-10）：<b>{pain} 分</b>
                <input type="range" min={0} max={10} value={pain} onChange={(e) => setPain(+e.target.value)} />
              </label>
              <label className="check"><input type="checkbox" checked={oral} onChange={(e) => setOral(e.target.checked)} /> 可饮水进食</label>
              <label className="check"><input type="checkbox" checked={urine} onChange={(e) => setUrine(e.target.checked)} /> 已排尿</label>
              <label className="check span2"><input type="checkbox" checked={med} onChange={(e) => setMed(e.target.checked)} /> 用药说明已交代</label>
              <label className="span2">复诊时间
                <input type="date" value={followup} onChange={(e) => setFollowup(e.target.value)} />
              </label>
              <Msg msg={msg} />
              <button
                className="btn btn-primary span2"
                onClick={() => {
                  const r = saveDischarge(selId, { painScore: pain, oralIntake: oral, urination: urine, medicationTold: med, followupAt: followup })
                  setMsg(r ?? '离院评估已保存，患者转入「待接走」')
                  if (!r) setSelId(null)
                }}
              >
                保存离院评估
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card title={`待接走（${waitingSign.length} 人）`} extra={<span className="muted">等待接送人在家属端签收</span>}>
        {waitingSign.length === 0 && <div className="muted">暂无</div>}
        {waitingSign.map((p) => (
          <div key={p.id} className="row-card">
            <div>
              <b>{p.name}</b> <StatusBadge status={p.status} /> <FeeBadge p={p} />
              <div className="muted">
                接送人：{p.pickup.name}（{p.pickup.relation} · {p.pickup.phone}） · 离院评估 {fmtTime(p.discharge?.at)} · 疼痛 {p.discharge?.painScore} 分 · 复诊 {p.discharge?.followupAt}
              </div>
              {!feeSettled(p) && <div className="warn">费用未结清，签收将被拦截，请通知收费窗口</div>}
            </div>
            <details>
              <summary>术后注意事项（签收后发给家属）</summary>
              <ul className="notes">{buildPostopNotes(p).map((n, i) => <li key={i}>{n}</li>)}</ul>
            </details>
          </div>
        ))}
      </Card>

      <Card title={`已离院（${discharged.length} 人）`}>
        {discharged.length === 0 && <div className="muted">暂无</div>}
        {discharged.map((p) => (
          <div key={p.id} className="row-card">
            <div>
              <b>{p.name}</b> <StatusBadge status={p.status} />
              <span className="muted">
                {' '}签收人 {p.pickupSign?.signer}（{p.pickupSign?.phone}） {fmtTime(p.pickupSign?.at)} · 复诊 {p.discharge?.followupAt}
              </span>
            </div>
            <details>
              <summary>术后注意事项</summary>
              <ul className="notes">{buildPostopNotes(p).map((n, i) => <li key={i}>{n}</li>)}</ul>
            </details>
          </div>
        ))}
      </Card>
    </div>
  )
}
