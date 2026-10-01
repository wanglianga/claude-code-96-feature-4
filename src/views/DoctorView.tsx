import { useEffect, useState } from "react";
import { api } from "../api";
import { SubTabs, PatientFolder } from "./NurseView";
import { StatusTag, fmt } from "../components/ui";

export default function DoctorView({ notify }: any) {
  const [tab, setTab] = useState("referrals");
  const [patientId, setPatientId] = useState<number | null>(null);

  const tabs: [string, string][] = [
    ["referrals", "转诊确认"],
    ["orders", "医嘱（补录/撤回）"],
    ["patients", "患者档案 / 时间线"],
  ];

  return (
    <>
      <SubTabs tabs={tabs} current={tab} onChange={setTab} />
      <div className="page">
        {patientId ? (
          <PatientFolder pid={patientId} onBack={() => setPatientId(null)} notify={notify} />
        ) : (
          <>
            {tab === "referrals" && <Referrals notify={notify} />}
            {tab === "orders" && <Orders notify={notify} />}
            {tab === "patients" && <Picker onPick={setPatientId} />}
          </>
        )}
      </div>
    </>
  );
}

function Referrals({ notify }: any) {
  const [list, setList] = useState<any[]>([]);
  const load = () => api("/staff/escalations?active_only=true").then(setList);
  useEffect(() => { load(); }, []);
  const decide = async (escId: number, refId: number, decision: string) => {
    const note = prompt(decision === "confirm" ? "确认转诊备注" : "驳回原因") || "";
    try {
      await api(`/doctor/referrals/${refId}/decision`, {
        method: "POST", body: { decision, note },
      });
      notify("ok", "转诊已" + (decision === "confirm" ? "确认" : "驳回"));
      load();
    } catch (e: any) { notify("err", e.message); }
  };
  const rows = list.flatMap((e) =>
    e.referrals.filter((r: any) => r.status === "requested" || r.status === "confirmed")
      .map((r: any) => ({ e, r })));
  return (
    <div className="panel">
      <h3>转诊申请</h3>
      {rows.length === 0 && <div className="muted">暂无待确认转诊</div>}
      <table>
        <thead><tr><th>申请时间</th><th>患者</th><th>升级单</th><th>目标</th><th>原因</th><th>状态</th><th></th></tr></thead>
        <tbody>
          {rows.map(({ e, r }) => (
            <tr key={r.id}>
              <td>{fmt(r.request_event_time)}</td>
              <td>{e.patient?.name}<div className="muted">{e.patient?.code}</div></td>
              <td>#{e.id} <StatusTag status={e.status} /></td>
              <td>{r.target}</td><td>{r.reason}</td>
              <td><StatusTag status={r.status} /></td>
              <td>
                {r.status === "requested" && <>
                  <button className="primary" onClick={() => decide(e.id, r.id, "confirm")}>确认</button>{" "}
                  <button className="danger" onClick={() => decide(e.id, r.id, "reject")}>驳回</button>
                </>}
                {r.confirmation_note && <div className="muted">{r.confirmation_note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">规则：转诊未经确认时，护士不能关闭升级单；患者在等待期间再次上报恶化会挂接同一升级单，不会重复转诊。</p>
    </div>
  );
}

function Orders({ notify }: any) {
  const [patients, setPatients] = useState<any[]>([]);
  const [pid, setPid] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);
  useEffect(() => { api("/staff/patients").then(setPatients); }, []);
  const load = (id: number) => { setPid(id); api(`/staff/patients/${id}`).then(setDetail); };

  const [form, setForm] = useState({
    order_type: "medication", content: "", task_title: "",
    due_at: "", event_time: "",
  });
  const submit = async () => {
    if (!pid || !form.content.trim()) { notify("err", "请选择患者并填写医嘱内容"); return; }
    try {
      const r = await api("/doctor/orders", {
        method: "POST",
        body: {
          patient_id: pid,
          order_type: form.order_type,
          content: form.content,
          task_title: form.task_title || undefined,
          due_at: form.due_at || undefined,
          event_time: form.event_time || undefined,
        },
      });
      notify("ok", `医嘱 #${r.order_id} 已下达${r.pharmacy_status === "pending" ? "，已转药师审方" : ""}`);
      setForm({ order_type: "medication", content: "", task_title: "", due_at: "", event_time: "" });
      load(pid);
    } catch (e: any) { notify("err", e.message); }
  };
  const withdraw = async (id: number) => {
    const reason = prompt("撤回原因（原始医嘱将保留，只追加撤回记录）") || "";
    if (!reason) return;
    await api(`/doctor/orders/${id}/withdraw`, { method: "POST", body: { reason } });
    notify("ok", "医嘱已撤回，原文保留可审计");
    if (pid) load(pid);
  };

  return (
    <div className="grid2">
      <div className="panel">
        <h3>选择患者</h3>
        <select value={pid ?? ""} onChange={(e) => load(Number(e.target.value))}>
          <option value="" disabled>请选择…</option>
          {patients.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
        </select>

        <h3 style={{ marginTop: 16 }}>下达 / 补录医嘱</h3>
        <label>医嘱类型</label>
        <select value={form.order_type}
                onChange={(e) => setForm({ ...form, order_type: e.target.value })}>
          <option value="medication">用药（自动转药师审方）</option>
          <option value="follow_adjust">随访计划调整（与旧计划冲突时自动取消/替代）</option>
          <option value="exam">检查</option>
          <option value="other">其他</option>
        </select>
        <label>医嘱内容</label>
        <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })}
                  placeholder="如：华法林 3mg 每日一次；或“停止常规电话随访，改术后第10天门诊”" />
        {form.order_type === "follow_adjust" && (
          <>
            <label>替代任务标题</label>
            <input value={form.task_title} onChange={(e) => setForm({ ...form, task_title: e.target.value })}
                   placeholder="如：术后第10天门诊复查随访" />
            <label>应办时间（可选）</label>
            <input type="datetime-local" value={form.due_at}
                   onChange={(e) => setForm({ ...form, due_at: e.target.value })} />
          </>
        )}
        <label>业务发生时间（留空=现在；可填写过去时间用于补录，时间线将按此排序）</label>
        <input type="datetime-local" value={form.event_time}
               onChange={(e) => setForm({ ...form, event_time: e.target.value })} />
        <button className="primary" style={{ marginTop: 12 }} onClick={submit}>下达医嘱</button>
      </div>

      <div className="panel">
        <h3>该患者医嘱与任务</h3>
        {!detail && <div className="muted">请先选择患者</div>}
        {detail && (
          <>
            <div className="muted" style={{ marginBottom: 8 }}>
              出院医嘱：{detail.patient.discharge_orders}；过敏史：{detail.patient.allergy}
            </div>
            <h3>历史医嘱（撤回不改写原文）</h3>
            <OrderList orders={detail.orders || []} onWithdraw={withdraw} />
            <h3 style={{ marginTop: 14 }}>随访任务的取消/替代关系</h3>
            <table>
              <tbody>
                {detail.tasks.map((t: any) => (
                  <tr key={t.id}>
                    <td>{t.title}</td><td><StatusTag status={t.status} /></td>
                    <td className="muted">
                      {t.superseded_by_order_id && `被医嘱 #${t.superseded_by_order_id} 替代`}
                      {t.cancel_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function OrderList({ orders, onWithdraw }: any) {
  if (!orders.length) return <div className="muted">暂无医嘱</div>;
  return (
    <table>
      <thead><tr><th>类型</th><th>内容</th><th>业务时间</th><th>状态/审方</th><th></th></tr></thead>
      <tbody>
        {orders.map((o: any) => (
          <tr key={o.id} style={{ opacity: o.status === "withdrawn" ? 0.6 : 1 }}>
            <td>{o.order_type}</td>
            <td style={o.status === "withdrawn" ? { textDecoration: "line-through" } : undefined}>
              {o.content}
              {o.withdraw_reason && <div className="tag red">撤回：{o.withdraw_reason}</div>}
              <div className="muted">{o.doctor_name} · 录入 {fmt(o.recorded_at)}</div>
            </td>
            <td>{fmt(o.event_time)}</td>
            <td><StatusTag status={o.status} /> <StatusTag status={o.pharmacy_status} /></td>
            <td>{o.status === "active" && <button className="danger" onClick={() => onWithdraw(o.id)}>撤回</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Picker({ onPick }: any) {
  const [ps, setPs] = useState<any[]>([]);
  useEffect(() => { api("/staff/patients").then(setPs); }, []);
  return (
    <div className="panel">
      <h3>患者列表</h3>
      <table>
        <tbody>
          {ps.map((p) => (
            <tr key={p.id} className="clickable" onClick={() => onPick(p.id)}>
              <td>{p.code}</td><td>{p.name}</td><td>{p.surgery_type}</td>
              <td><button>档案与时间线</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
