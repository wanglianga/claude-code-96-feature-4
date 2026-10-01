import { useState, useCallback } from "react";
import { api, clearSession, getSessionUser, setSession } from "./api";
import Login from "./Login";
import PatientView from "./views/PatientView";
import NurseView from "./views/NurseView";
import DoctorView from "./views/DoctorView";
import PharmacistView from "./views/PharmacistView";

export type Toast = { kind: "ok" | "err"; text: string } | null;

export default function App() {
  const [user, setUser] = useState<any>(getSessionUser());
  const [toast, setToast] = useState<Toast>(null);

  const notify = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  if (!user) {
    return (
      <>
        <Login
          onLogin={async (kind, body) => {
            const path = kind === "staff" ? "/auth/staff/login" : "/auth/patient/login";
            const data = await api(path, { method: "POST", body });
            setSession(data.token, data.user);
            setUser(data.user);
          }}
          onError={(m) => notify("err", m)}
        />
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </>
    );
  }

  const logout = () => {
    clearSession();
    setUser(null);
  };

  return (
    <>
      <div className="topbar">
        <span className="brand">仁和医院 · 出院随访与高风险升级平台</span>
        <span className="who">
          {user.kind === "patient" ? "患者端" : roleLabel(user.role)} · {user.name}
        </span>
        <button onClick={logout}>退出登录</button>
      </div>
      {user.kind === "patient" && <PatientView user={user} notify={notify} />}
      {user.role === "nurse" && <NurseView user={user} notify={notify} />}
      {user.role === "doctor" && <DoctorView user={user} notify={notify} />}
      {user.role === "pharmacist" && <PharmacistView user={user} notify={notify} />}
      {(user.role === "admin") && <NurseView user={user} notify={notify} admin />}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </>
  );
}

function roleLabel(role: string) {
  return { nurse: "护士站", doctor: "医生工作站", pharmacist: "药师审方台", admin: "管理员" }[role] || role;
}
