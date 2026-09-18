import { useStore } from '../store'
import { expectedOrder, fmtTime } from '../utils'
import { FeeBadge, FlagBadges, StatusBadge } from '../components/common'

/** 候诊区看板：签到后展示手术类型、禁食、过敏、检查、缴费、陪诊/接送人、预计手术顺序 */
export default function BoardTab() {
  const patients = useStore((s) => s.patients)
  const checkIn = useStore((s) => s.checkIn)
  const order = expectedOrder(patients)

  const rows = patients
    .slice()
    .sort((a, b) => {
      const rank = (s: string) => (s === 'booked' ? 2 : s === 'discharged' ? 1 : 0)
      return rank(a.status) - rank(b.status) || a.queueNo - b.queueNo
    })

  return (
    <div className="card">
      <header className="card-head">
        <h3>候诊区看板（当日患者）</h3>
        <span className="muted">预计手术顺序 = 绿色通道优先，其余按签到顺序</span>
      </header>
      <div className="card-body table-wrap">
        <table>
          <thead>
            <tr>
              <th>顺序</th><th>患者</th><th>手术类型 / 麻醉</th><th>禁食至</th><th>过敏史</th>
              <th>术前检查</th><th>缴费</th><th>陪诊人</th><th>接送人</th><th>状态</th><th>标记</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="order-cell">
                  {p.status === 'waiting' ? (
                    <span className="order-no">{order.get(p.id)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <b>{p.name}</b>
                  <div className="muted">{p.gender} · {p.age}岁</div>
                </td>
                <td>
                  {p.surgeryType}
                  <div className="muted">{p.anesthesia}</div>
                </td>
                <td>{p.fastingUntil}</td>
                <td>{p.allergies.length ? <span className="allergy">{p.allergies.join('、')}</span> : <span className="muted">无</span>}</td>
                <td>
                  {p.exams.every((e) => e.done) ? (
                    <span className="ok">齐全（{p.exams.length}项）</span>
                  ) : (
                    <span className="warn">缺 {p.exams.filter((e) => !e.done).map((e) => e.name).join('、')}</span>
                  )}
                </td>
                <td>
                  <FeeBadge p={p} />
                  <div className="muted">{p.payment.paid}/{p.payment.total}元</div>
                </td>
                <td>{p.escort.name}<div className="muted">{p.escort.relation} · {p.escort.phone}</div></td>
                <td>{p.pickup.name}<div className="muted">{p.pickup.relation} · {p.pickup.phone}</div></td>
                <td><StatusBadge status={p.status} /></td>
                <td><FlagBadges p={p} /></td>
                <td>
                  {p.status === 'booked' && (
                    <button className="btn btn-primary btn-sm" onClick={() => checkIn(p.id)}>到院签到</button>
                  )}
                  {p.checkedInAt && <div className="muted">签到 {fmtTime(p.checkedInAt)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
