import { useState } from 'react'
import { ACCOUNTS } from '../data'
import { useStore } from '../store'

const ROLE_LABEL: Record<string, string> = {
  nurse: '护士端',
  anesthetist: '麻醉医生端',
  cashier: '收费窗口端',
  family: '家属端',
}

export default function Login() {
  const login = useStore((s) => s.login)
  const [account, setAccount] = useState('nurse01')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const r = login(account.trim(), password)
    if (r) setErr(r)
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>仁和医院 · 日间手术中心</h1>
        <p className="muted">患者陪诊交接与术后接送平台</p>
        <form onSubmit={submit}>
          <label>
            账号
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              {ACCOUNTS.map((a) => (
                <option key={a.account} value={a.account}>
                  {a.account}（{ROLE_LABEL[a.role]} · {a.title}）
                </option>
              ))}
            </select>
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              placeholder="演示密码 123456"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {err && <div className="msg">{err}</div>}
          <button className="btn btn-primary btn-block" type="submit">
            登录
          </button>
        </form>
        <div className="login-hint">
          <b>演示账号（密码均为 123456）</b>
          <ul>
            <li>nurse01 护士张敏 — 完整病情与护理动作</li>
            <li>anes01 麻醉医生李航 — 手术区麻醉与体征异常</li>
            <li>cash01 收费窗口王芳 — 仅费用信息</li>
            <li>family01~04 家属 — 仅脱敏状态进度 + 交接/签收</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
