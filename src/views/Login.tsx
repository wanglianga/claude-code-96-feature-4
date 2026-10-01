import React, { useState } from 'react';
import { useStore } from '../store';
import { SEED_USERS } from '../seed';
import { ROLE_LABEL } from '../store';

const Login: React.FC = () => {
  const login = useStore((s) => s.login);
  const [name, setName] = useState('nurse');
  const [pwd, setPwd] = useState('123456');
  const [err, setErr] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!login(name.trim(), pwd)) setErr(true);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>出院后分级随访与高风险升级平台</h1>
        <div className="sub">仁和医院 · 术后随访管理（事件溯源 / 分级授权 / 脱敏展示）</div>
        <form onSubmit={submit}>
          <div className="field">
            <label>账号</label>
            <input type="text" value={name} onChange={(e) => { setName(e.target.value); setErr(false); }} autoFocus />
          </div>
          <div className="field">
            <label>密码</label>
            <input type="text" value={pwd} onChange={(e) => { setPwd(e.target.value); setErr(false); }} />
          </div>
          {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>账号或密码错误</div>}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '9px' }} type="submit">
            登录
          </button>
        </form>
        <div className="login-accounts">
          <div className="sub" style={{ margin: '0 0 6px' }}>演示账号（点击自动填充，密码均为 123456）：</div>
          {SEED_USERS.map((u) => (
            <div key={u.id} className="acc" onClick={() => { setName(u.login); setPwd(u.password); setErr(false); }}>
              <span><b>{u.name}</b> <span className="muted">· {ROLE_LABEL[u.role]}</span></span>
              <code>{u.login}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Login;
