import { useState } from 'react'
import { useStore } from '../store'
import type { Patient } from '../types'
import { enterOrBlockers, fmtTime, orReadyChecklist, waitingQueue } from '../utils'
import { Card, ExceptionList, FlagBadges, Msg, StatusBadge } from '../components/common'

const ANES_TYPES = ['全身麻醉', '腰麻', '神经阻滞麻醉', '局部麻醉', '表面麻醉', '静脉镇静']

function OrCard({ p, role }: { p: Patient; role: 'nurse' | 'anesthetist' }) {
  const { advance, markBpAbnormal, delaySurgery, changeAnesthesia, resolveException } = useStore()
  const [msg, setMsg] = useState<string | null>(null)
  const [openForm, setOpenForm] = useState<'' | 'bp' | 'delay' | 'anes'>('')
  const [bpText, setBpText] = useState('')
  const [delayMin, setDelayMin] = useState(15)
  const [delayReason, setDelayReason] = useState('')
  const [anesNext, setAnesNext] = useState(ANES_TYPES[0])
  const [anesReason, setAnesReason] = useState('')

  const blockers = p.status === 'waiting' ? enterOrBlockers(p) : []
  const doAdvance = () => setMsg(advance(p.id))

  return (
    <Card
      title={`${p.name} · ${p.surgeryType}`}
      extra={<span className="flags"><StatusBadge status={p.status} /><FlagBadges p={p} /></span>}
    >
      <div className="kv">
        <span>麻醉方式</span><b>{p.anesthesia}</b>
        <span>过敏史</span><b>{p.allergies.length ? p.allergies.join('、') : '无'}</b>
        {p.assessment && (
          <>
            <span>生命体征</span>
            <b>BP {p.assessment.sbp}/{p.assessment.dbp} · HR {p.assessment.hr} · SpO2 {p.assessment.spo2}%</b>
            <span>皮试</span><b>{p.assessment.skinTest}</b>
          </>
        )}
        <span>交接确认</span>
        <b>
          {p.handover
            ? `${fmtTime(p.handover.confirmedAt)} · 物品袋 ${p.handover.bagNo} · 术后联系 ${p.handover.contactPhone}（${p.handover.escortName}）`
            : '等待陪诊人在家属端确认（物品袋编号 / 术后联系号码）'}
        </b>
      </div>

      {p.status === 'waiting' && (
        <div className="or-ready">
          <b>手术间准备核查：</b>
          <ul>
            {orReadyChecklist(p).map((c) => (
              <li key={c.label} className={c.ok ? 'ok' : 'warn'}>{c.ok ? '✓' : '✗'} {c.label}</li>
            ))}
          </ul>
          {blockers.length > 0 && <div className="warn">暂不能入室：{blockers.join('；')}</div>}
        </div>
      )}

      <Msg msg={msg} />

      <div className="btn-row">
        {role === 'nurse' && p.status === 'waiting' && (
          <button className="btn btn-primary" disabled={blockers.length > 0} onClick={doAdvance}>送入手术间</button>
        )}
        {role === 'nurse' && p.status === 'in_or' && (
          <button className="btn btn-primary" onClick={doAdvance}>手术开始</button>
        )}
        {role === 'nurse' && p.status === 'in_surgery' && (
          <button className="btn btn-primary" onClick={doAdvance}>手术结束，转复苏室</button>
        )}
        {(role === 'nurse' || role === 'anesthetist') && p.status !== 'discharged' && (
          <>
            <button className="btn" onClick={() => setOpenForm(openForm === 'bp' ? '' : 'bp')}>血压异常</button>
            <button className="btn" onClick={() => setOpenForm(openForm === 'anes' ? '' : 'anes')}>麻醉方式改变</button>
          </>
        )}
        {role === 'nurse' && (p.status === 'waiting' || p.status === 'in_or') && (
          <button className="btn" onClick={() => setOpenForm(openForm === 'delay' ? '' : 'delay')}>手术延迟</button>
        )}
      </div>

      {openForm === 'bp' && (
        <div className="inline-form">
          <input placeholder="如 复测 170/100，已通知麻醉医生" value={bpText} onChange={(e) => setBpText(e.target.value)} />
          <button className="btn btn-primary" onClick={() => { if (bpText.trim()) { markBpAbnormal(p.id, bpText.trim()); setBpText(''); setOpenForm('') } }}>登记</button>
        </div>
      )}
      {openForm === 'delay' && (
        <div className="inline-form">
          <input placeholder="延迟原因" value={delayReason} onChange={(e) => setDelayReason(e.target.value)} />
          <input type="number" style={{ width: 90 }} value={delayMin} onChange={(e) => setDelayMin(+e.target.value)} />
          <span className="muted">分钟</span>
          <button className="btn btn-primary" onClick={() => { if (delayReason.trim()) { delaySurgery(p.id, delayMin, delayReason.trim()); setDelayReason(''); setOpenForm('') } }}>登记</button>
        </div>
      )}
      {openForm === 'anes' && (
        <div className="inline-form">
          <select value={anesNext} onChange={(e) => setAnesNext(e.target.value)}>
            {ANES_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <input placeholder="变更原因" value={anesReason} onChange={(e) => setAnesReason(e.target.value)} />
          <button className="btn btn-primary" onClick={() => { if (anesReason.trim()) { changeAnesthesia(p.id, anesNext, anesReason.trim()); setAnesReason(''); setOpenForm('') } }}>确认变更</button>
        </div>
      )}

      <details>
        <summary>异常事件（{p.exceptions.filter((e) => !e.resolved).length} 未闭环 / 共 {p.exceptions.length} 条）</summary>
        <ExceptionList p={p} onResolve={role === 'nurse' ? (exId) => resolveException(p.id, exId) : undefined} />
      </details>
    </Card>
  )
}

/** 手术区视图：护士与麻醉医生共用（操作权限不同） */
export default function OrTab({ role }: { role: 'nurse' | 'anesthetist' }) {
  const patients = useStore((s) => s.patients)
  const waiting = waitingQueue(patients)
  const inOr = patients.filter((p) => p.status === 'in_or')
  const inSurgery = patients.filter((p) => p.status === 'in_surgery')

  const group = (title: string, list: Patient[], hint?: string) => (
    <div className="or-group">
      <h3 className="group-title">{title} <span className="muted">（{list.length}）</span>{hint && <span className="muted"> · {hint}</span>}</h3>
      {list.length === 0 && <div className="muted empty">暂无患者</div>}
      {list.map((p) => <OrCard key={p.id} p={p} role={role} />)}
    </div>
  )

  return (
    <div>
      {group('待入室（按预计手术顺序）', waiting, '绿色通道优先')}
      {group('已入室', inOr)}
      {group('手术中', inSurgery)}
    </div>
  )
}
