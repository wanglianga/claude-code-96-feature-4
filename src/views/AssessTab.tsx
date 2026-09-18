import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Card, Msg, StatusBadge } from '../components/common'
import { fmtTime } from '../utils'

const empty = {
  sbp: 120, dbp: 80, hr: 75, spo2: 98, temp: 36.5,
  skinTest: '未做' as '阴性' | '阳性' | '未做',
  consentSigned: false, belongingsSealed: false, bagNo: '', greenChannel: false, note: '',
}

/** 术前评估区：生命体征 / 皮试 / 知情同意 / 物品封存 / 绿色通道 */
export default function AssessTab() {
  const patients = useStore((s) => s.patients)
  const saveAssessment = useStore((s) => s.saveAssessment)
  const candidates = patients.filter((p) => p.status === 'registered' || p.status === 'waiting')
  const [selId, setSelId] = useState<string | null>(candidates[0]?.id ?? null)
  const sel = candidates.find((p) => p.id === selId) ?? null
  const [form, setForm] = useState(empty)
  const [msg, setMsg] = useState<string | null>(null)

  const pick = (id: string) => {
    setSelId(id)
    setMsg(null)
    const p = candidates.find((x) => x.id === id)
    if (p?.assessment) {
      const a = p.assessment
      setForm({
        sbp: a.sbp, dbp: a.dbp, hr: a.hr, spo2: a.spo2, temp: a.temp,
        skinTest: a.skinTest, consentSigned: a.consentSigned,
        belongingsSealed: a.belongingsSealed, bagNo: a.bagNo,
        greenChannel: a.greenChannel, note: a.note,
      })
    } else if (p) {
      setForm({ ...empty, bagNo: `B-${String(p.queueNo).padStart(3, '0')}` })
    }
  }

  const bpWarn = useMemo(() => form.sbp >= 160 || form.sbp < 90 || form.dbp >= 100 || form.dbp < 50, [form.sbp, form.dbp])

  const submit = () => {
    if (!sel) return
    if (!form.bagNo.trim() && form.belongingsSealed) {
      setMsg('已封存物品必须填写物品袋编号')
      return
    }
    saveAssessment(sel.id, form)
    setMsg(`已保存 ${sel.name} 的术前评估${sel.status === 'registered' ? '，患者进入候诊区排序' : '（更新）'}`)
  }

  return (
    <div className="two-col">
      <Card title="待评估患者">
        {candidates.length === 0 && <div className="muted">暂无待评估患者</div>}
        <ul className="pick-list">
          {candidates.map((p) => (
            <li key={p.id} className={p.id === selId ? 'active' : ''} onClick={() => pick(p.id)}>
              <b>{p.name}</b> <span className="muted">{p.surgeryType}</span>
              <StatusBadge status={p.status} />
              {p.assessment && <span className="muted">已评估 {fmtTime(p.assessment.at)}</span>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={sel ? `术前评估录入 — ${sel.name}` : '术前评估录入'}>
        {!sel ? (
          <div className="muted">请选择患者</div>
        ) : (
          <div className="form-grid">
            <label>收缩压 (mmHg)
              <input type="number" value={form.sbp} onChange={(e) => setForm({ ...form, sbp: +e.target.value })} />
            </label>
            <label>舒张压 (mmHg)
              <input type="number" value={form.dbp} onChange={(e) => setForm({ ...form, dbp: +e.target.value })} />
            </label>
            <label>心率 (次/分)
              <input type="number" value={form.hr} onChange={(e) => setForm({ ...form, hr: +e.target.value })} />
            </label>
            <label>血氧 SpO2 (%)
              <input type="number" value={form.spo2} onChange={(e) => setForm({ ...form, spo2: +e.target.value })} />
            </label>
            <label>体温 (℃)
              <input type="number" step="0.1" value={form.temp} onChange={(e) => setForm({ ...form, temp: +e.target.value })} />
            </label>
            <label>皮试结果
              <select value={form.skinTest} onChange={(e) => setForm({ ...form, skinTest: e.target.value as typeof form.skinTest })}>
                <option>未做</option><option>阴性</option><option>阳性</option>
              </select>
            </label>
            {bpWarn && <div className="warn span2">⚠ 血压异常，保存后请麻醉医生复核（可在手术区登记血压异常事件）</div>}
            {form.skinTest === '阳性' && <div className="warn span2">⚠ 皮试阳性，已提示通知医生调整用药</div>}
            <label className="check span2">
              <input type="checkbox" checked={form.consentSigned} onChange={(e) => setForm({ ...form, consentSigned: e.target.checked })} />
              知情同意书已签署（未签署将无法进入手术间）
            </label>
            <label className="check">
              <input type="checkbox" checked={form.belongingsSealed} onChange={(e) => setForm({ ...form, belongingsSealed: e.target.checked })} />
              随身物品已封存
            </label>
            <label>物品袋编号
              <input value={form.bagNo} onChange={(e) => setForm({ ...form, bagNo: e.target.value })} placeholder="如 B-001" />
            </label>
            <label className="check span2">
              <input type="checkbox" checked={form.greenChannel} onChange={(e) => setForm({ ...form, greenChannel: e.target.checked })} />
              绿色通道（急危重症优先排序，可先诊疗后付费）
            </label>
            <label className="span2">备注
              <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={2} />
            </label>
            <Msg msg={msg} />
            <button className="btn btn-primary span2" onClick={submit}>保存评估{sel.status === 'registered' ? '并进入候诊区' : ''}</button>
          </div>
        )}
      </Card>
    </div>
  )
}
