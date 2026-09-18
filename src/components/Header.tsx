import { useStore } from '../store'
import { fmtTime } from '../utils'

export default function Header() {
  const { user, now, tick, logout } = useStore()
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark">✚</span>
        <div>
          <div className="brand-name">仁和医院 · 日间手术中心</div>
          <div className="brand-sub">陪诊交接与术后接送平台</div>
        </div>
      </div>
      <div className="header-right">
        <div className="clock" title="演示用模拟时钟，可快进以触发时间相关规则">
          <span className="clock-label">模拟时钟</span>
          <span className="clock-time">2026-09-18 {fmtTime(now)}</span>
          <button className="btn btn-xs" onClick={() => tick(15)}>+15分钟</button>
          <button className="btn btn-xs" onClick={() => tick(30)}>+30分钟</button>
        </div>
        {user && (
          <div className="user-chip">
            <span>
              {user.title} · {user.name}
            </span>
            <button className="btn btn-xs" onClick={logout}>退出</button>
          </div>
        )}
      </div>
    </header>
  )
}
