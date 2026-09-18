import { useState } from 'react'
import { useStore } from '../store'
import { FAMILY_STEPS, STATUS_META, buildPostopNotes, expectedOrder, feeSettled, fmtTime, isProlonged } from '../utils'
import { Card, Msg, Timeline } from '../components/common'

/** 家属端：仅可见脱敏状态进度；在对应节点完成交接确认与签收 */
export default function FamilyView({ patientId }: { patientId: string }) {
  const store = useStore()
  const { patients, now } = store
  const p = patients.find((x) => x.id === patientId)
  const [msg, setMsg] = useState<string | null>(null)

  // 交接确认表单
  const [bagNo, setBagNo] = useState('')
  const [contact, setContact] = useState('')
  // 签收表单
  const [signer, setSigner] = useState('')
  const [signPhone, setSignPhone] = useState('')
  // 更换接送人表单
  const [np, setNp] = useState({ name: '', phone: '', relation: '' })
  const [showChange, setShowChange] = useState(false)

  if (!p) return <div className="card"><div className="card-body">未找到绑定的患者，请联系护士站。</div></div>

  const stepIdx = FAMILY_STEPS.indexOf(p.status === 'booked' ? 'registered' : p.status)
  const order = expectedOrder(patients).get(p.id)
  const escortLeft = p.exceptions.some((e) => e.type === 'escort_leave' && !e.resolved)
  const prolonged = p.status === 'recovery' && isProlonged(p, now)

  return (
    <div>
      <Card title={`${p.name} · ${p.surgeryType}`} extra={<span className="muted">为保护隐私，本页面仅展示状态进度说明</span>}>
        <div className="stepper">
          {FAMILY_STEPS.map((s, i) => (
            <div key={s} className={`step ${i < stepIdx ? 'done' : ''} ${i === stepIdx ? 'current' : ''}`}>
              <div className="step-dot">{i < stepIdx ? '✓' : i + 1}</div>
              <div className="step-label">{STATUS_META[s].label}</div>
            </div>
          ))}
        </div>
        <div className="family-status">
          当前状态：<b style={{ color: STATUS_META[p.status].color }}>{STATUS_META[p.status].label}</b>
          {p.status === 'waiting' && order && <span> · 预计第 <b>{order}</b> 台手术{p.delayedMin > 0 ? `（预计延迟 ${p.delayedMin} 分钟）` : ''}</span>}
          {prolonged && <div className="alert" style={{ marginTop: 8 }}>患者恢复时间略长，医护人员正在密切观察，如有需要护士会电话联系您，请耐心等待。</div>}
        </div>
        <Msg msg={msg} />
      </Card>

      {p.status === 'waiting' && !p.handover && (
        <Card title="交接确认（患者即将进入手术区）" extra={<span className="badge badge-amber">待您确认</span>}>
          <p className="muted">请核对并确认：交接时间（取当前时间）、物品袋编号、术后联系号码。</p>
          <div className="form-grid">
            <label>物品袋编号
              <input value={bagNo || p.assessment?.bagNo || ''} onChange={(e) => setBagNo(e.target.value)} placeholder="护士封存时告知的编号" />
            </label>
            <label>术后联系号码
              <input value={contact || p.escort.phone} onChange={(e) => setContact(e.target.value)} />
            </label>
            <button
              className="btn btn-primary span2"
              onClick={() => {
                const r = store.confirmHandover(p.id, {
                  bagNo: (bagNo || p.assessment?.bagNo || '').trim(),
                  contactPhone: (contact || p.escort.phone).trim(),
                  escortName: store.user?.name ?? p.escort.name,
                })
                setMsg(r ?? '交接确认完成，患者可进入手术区')
              }}
            >
              确认交接
            </button>
          </div>
        </Card>
      )}

      {p.handover && (
        <Card title="交接信息">
          <div className="kv">
            <span>交接时间</span><b>{fmtTime(p.handover.confirmedAt)}</b>
            <span>物品袋编号</span><b>{p.handover.bagNo}</b>
            <span>术后联系号码</span><b>{p.handover.contactPhone}</b>
          </div>
        </Card>
      )}

      {p.status === 'ready_pickup' && (
        <Card title="离院签收" extra={<span className="badge badge-amber">待签收</span>}>
          {!feeSettled(p) && <div className="warn">费用尚未结清，请先到收费窗口办理后再签收。</div>}
          <div className="form-grid">
            <label>签收人姓名
              <input value={signer || p.pickup.name} onChange={(e) => setSigner(e.target.value)} />
            </label>
            <label>联系电话
              <input value={signPhone || p.pickup.phone} onChange={(e) => setSignPhone(e.target.value)} />
            </label>
            <button
              className="btn btn-primary span2"
              onClick={() => {
                const r = store.signPickup(p.id, (signer || p.pickup.name).trim(), (signPhone || p.pickup.phone).trim())
                setMsg(r ?? '签收完成，患者已离院。术后注意事项与复诊时间请见下方。')
              }}
            >
              确认签收并离院
            </button>
          </div>
        </Card>
      )}

      {p.status === 'discharged' && (
        <Card title="术后注意事项">
          <ul className="notes">{buildPostopNotes(p).map((n, i) => <li key={i}>{n}</li>)}</ul>
          <p className="muted">护士站将在 24 小时内进行电话回访，请保持 {p.pickupSign?.phone ?? p.pickup.phone} 畅通。</p>
        </Card>
      )}

      {p.status !== 'discharged' && (
        <Card title="陪诊 / 接送信息">
          <div className="kv">
            <span>陪诊人</span><b>{p.escort.name}（{p.escort.relation} · {p.escort.phone}）{escortLeft ? ' · 已登记暂时离院' : ''}</b>
            <span>接送人</span><b>{p.pickup.name}（{p.pickup.relation} · {p.pickup.phone}）</b>
          </div>
          <div className="btn-row">
            {!escortLeft && ['waiting', 'in_or', 'in_surgery', 'recovery'].includes(p.status) && (
              <button className="btn" onClick={() => { store.escortLeave(p.id); setMsg('已登记陪诊人暂时离院，护士站知悉') }}>陪诊人暂时离院登记</button>
            )}
            <button className="btn" onClick={() => setShowChange(!showChange)}>更换接送人</button>
          </div>
          {showChange && (
            <div className="inline-form">
              <input placeholder="姓名" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} />
              <input placeholder="关系" value={np.relation} onChange={(e) => setNp({ ...np, relation: e.target.value })} />
              <input placeholder="电话" value={np.phone} onChange={(e) => setNp({ ...np, phone: e.target.value })} />
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (np.name.trim() && np.phone.trim()) {
                    store.changePickup(p.id, { name: np.name.trim(), phone: np.phone.trim(), relation: np.relation.trim() || '家属' })
                    setNp({ name: '', phone: '', relation: '' })
                    setShowChange(false)
                    setMsg('接送人已更换，护士站与收费窗口可见')
                  }
                }}
              >
                确认更换
              </button>
            </div>
          )}
        </Card>
      )}

      <Card title="进度说明（脱敏）">
        <Timeline p={p} publicOnly />
      </Card>
    </div>
  )
}
