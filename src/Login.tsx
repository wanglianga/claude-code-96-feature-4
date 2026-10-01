import { useState } from "react";
import { ApiError } from "./api";

export default function Login({
  onLogin,
  onError,
}: {
  onLogin: (kind: "staff" | "patient", body: any) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [kind, setKind] = useState<"staff" | "patient">("staff");
  const [username, setUsername] = useState("nurse.wang");
  const [password, setPassword] = useState("nurse123");
  const [code, setCode] = useState("P2026001");
  const [tail, setTail] = useState("1234");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      if (kind === "staff") await onLogin("staff", { username, password });
      else await onLogin("patient", { code, id_card_tail: tail });
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>出院随访平台</h1>
        <p className="muted">分级随访 · 高风险升级 · 全程可追溯</p>
        <div className="seg" style={{ margin: "16px 0" }}>
          <button className={kind === "staff" ? "active" : ""}
                  onClick={() => setKind("staff")}>医护登录</button>
          <button className={kind === "patient" ? "active" : ""}
                  onClick={() => setKind("patient")}>患者受限入口</button>
        </div>

        {kind === "staff" ? (
          <>
            <label>工号</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
            <label>密码</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && submit()} />
          </>
        ) : (
          <>
            <label>病案号</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} />
            <label>身份证后 4 位</label>
            <input value={tail} maxLength={4} onChange={(e) => setTail(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && submit()} />
            <p className="muted" style={{ marginBottom: 0 }}>
              受限入口仅可上报症状/体征与查看本人随访记录。
            </p>
          </>
        )}
        <button className="primary" style={{ width: "100%", marginTop: 18 }}
                disabled={busy} onClick={submit}>
          {busy ? "登录中…" : "登 录"}
        </button>

        <div className="accounts">
          <div>演示账号（工号 / 密码）：</div>
          <div><code>nurse.wang / nurse123</code> 王敏·护士</div>
          <div><code>doctor.li / doctor123</code> 李建国·医生</div>
          <div><code>pharma.zhou / pharma123</code> 周药·药师</div>
          <div><code>admin / admin123</code> 管理员（可手动触发后台巡检）</div>
          <div>患者：病案号 <code>P2026001</code> + 身份证后4位 <code>1234</code>（张伟）</div>
        </div>
      </div>
    </div>
  );
}
