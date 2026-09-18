import { useState } from 'react'
import { useStore } from '../store'
import { feeSettled } from '../utils'
import { FeeBadge, Card } from '../components/common'

/** 收费窗口：仅可见费用信息（脱敏边界），收款后同一条手术记录实时推进 */
export default function CashierView() {
  const { patients, settlePayment } = useStore()
  const [part, setPart] = useState<Record<string, string>>({})
  const rows = patients.filter((p) => p.status !== 'booked')

  return (
    <Card title="收费窗口 — 日间手术费用" extra={<span className="muted">仅展示费用相关信息，不涉及病情细节</span>}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>患者</th><th>手术类型</th><th>应收（元）</th><th>已收（元）</th><th>状态</th><th>收款</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const owed = p.payment.total - p.payment.paid
              return (
                <tr key={p.id}>
                  <td><b>{p.name}</b></td>
                  <td>{p.surgeryType}</td>
                  <td>{p.payment.total}</td>
                  <td>{p.payment.paid}</td>
                  <td><FeeBadge p={p} /></td>
                  <td>
                    {feeSettled(p) ? (
                      <span className="ok">已结清</span>
                    ) : (
                      <span className="inline-form" style={{ marginTop: 0 }}>
                        <button className="btn btn-primary btn-sm" onClick={() => settlePayment(p.id, owed)}>
                          结清 {owed} 元
                        </button>
                        <input
                          style={{ width: 90 }}
                          placeholder="部分收款"
                          value={part[p.id] ?? ''}
                          onChange={(e) => setPart({ ...part, [p.id]: e.target.value })}
                        />
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            const v = Math.floor(+((part[p.id] ?? '').trim()))
                            if (v > 0) { settlePayment(p.id, v); setPart({ ...part, [p.id]: '' }) }
                          }}
                        >
                          收
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
