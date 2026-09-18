import { useStore } from '../store'
import { EX_META, computeStats, fmtDur, fmtTime } from '../utils'
import { Card } from '../components/common'

/** 当日手术周转统计（复苏滞留原因自动带入） */
export default function StatsTab() {
  const { patients, followups, completeFollowup } = useStore()
  const stats = computeStats(patients)

  return (
    <div>
      <div className="stat-grid">
        <div className="stat"><div className="stat-num">{stats.checkedIn}</div><div className="stat-label">今日到院（人）</div></div>
        <div className="stat"><div className="stat-num">{stats.inSurgery}</div><div className="stat-label">手术区内</div></div>
        <div className="stat"><div className="stat-num">{stats.inRecovery}</div><div className="stat-label">复苏观察中</div></div>
        <div className="stat"><div className="stat-num">{stats.discharged}</div><div className="stat-label">已离院</div></div>
        <div className="stat"><div className="stat-num">{stats.avgRecoveryMin == null ? '—' : `${stats.avgRecoveryMin}分`}</div><div className="stat-label">平均复苏时长</div></div>
        <div className="stat"><div className="stat-num">{stats.avgTurnoverMin == null ? '—' : fmtDur(stats.avgTurnoverMin * 60000)}</div><div className="stat-label">平均周转（入室→离院）</div></div>
      </div>

      <div className="two-col">
        <Card title={`复苏滞留（${stats.prolonged.length} 例）`} extra={<span className="muted">原因带入周转统计</span>}>
          {stats.prolonged.length === 0 && <div className="muted">暂无滞留记录</div>}
          <table>
            <thead><tr><th>患者</th><th>滞留原因</th><th>复苏入室</th><th>备注</th></tr></thead>
            <tbody>
              {stats.prolonged.map(({ patient: p, reason }) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td><span className="badge badge-amber">{reason}</span></td>
                  <td>{fmtTime(p.recovery?.enteredAt)}</td>
                  <td className="muted">{p.recovery?.prolongedNote || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="异常事件分布">
          {Object.keys(stats.exceptionCount).length === 0 && <div className="muted">暂无异常事件</div>}
          <ul className="stat-list">
            {Object.entries(stats.exceptionCount).map(([type, count]) => (
              <li key={type}>
                <span>{EX_META[type as keyof typeof EX_META].label}</span>
                <b>{count} 起</b>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title={`回访任务（未完成 ${followups.filter((f) => !f.done).length} 条）`} extra={<span className="muted">签收离院时自动生成术后注意事项与异常回访任务</span>}>
        {followups.length === 0 && <div className="muted">暂无回访任务</div>}
        <ul className="task-list">
          {followups
            .slice()
            .sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt)
            .map((f) => (
              <li key={f.id} className={f.done ? 'done' : ''}>
                <span>
                  <b>{f.patientName}</b> · {f.reason}
                  <span className="muted">（生成于 {fmtTime(f.createdAt)}）</span>
                </span>
                {f.done ? <span className="ok">已完成</span> : (
                  <button className="btn btn-xs" onClick={() => completeFollowup(f.id)}>标记完成</button>
                )}
              </li>
            ))}
        </ul>
      </Card>
    </div>
  )
}
