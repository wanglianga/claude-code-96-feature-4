import { useEffect, useState } from "react";
import { api } from "../api";
import { SubTabs, PatientFolder } from "./NurseView";
import { StatusTag } from "../components/ui";

export default function PharmacistView({ notify }: any) {
  const [tab, setTab] = useState("review");
  const [patientId, setPatientId] = useState<number | null>(null);
  const tabs: [string, string][] = [
    ["review", "用药审方"],
    ["patients", "患者（脱敏）/ 时间线"],
  ];
  return (
    <>
      <SubTabs tabs={tabs} current={tab} onChange={setTab} />
      <div className="page">
        {patientId ? (
          <PatientFolder pid={patientId} onBack={() => { setPatientId(null); setTab("review"); }} notify={notify} />
        ) : (
          <>
            {tab === "review" && <ReviewBoard notify={notify} onOpen={(id: number) => setPatientId(id)} />}
            {tab === "patients" && <Picker onPick={setPatientId} />}
          </>
        )}
      </div>
    </>
  );
}

function ReviewBoard({ notify, onOpen }: any) {
  const [patients, setPatients] = useState<any[]>([]);
  const [pid, setPid] = useState<number | null>(null);
  const [med, setMed] = useState<any>(null);
  const [form, setForm] = useState({ order_id: null as number | null, found: false,
                                    detail: "", advice: "" });
  useEffect(() => { api("/staff/patients").then(setPatients); }, []);
  const load = async (id: number) => {
    setPid(id);
    setMed(await api(`/pharmacist/patients/${id}/medication`));
  };

  const submit = async () => {
    if (!pid) return;
    try {
      await api("/pharmacist/reviews", {
        method: "POST",
        body: {
          patient_id: pid,
          order_id: form.order_id,
          interaction_found: form.found,
          interaction_detail: form.detail,
          advice: form.advice,
        },
      });
      notify("ok", "审方意见已记录（不会改变医生诊疗结论，仅通知医生参考）");
      setForm({ order_id: null, found: false, detail: "", advice: "" });
      load(pid);
    } catch (e: any) { notify("err", e.message); }
  };

  return (
    <div className="grid2">
      <div className="panel">
        <h3>选择患者（姓名/手机已按药师权限脱敏）</h3>
        <select value={pid ?? ""} onChange={(e) => load(Number(e.target.value))}>
          <option value="" disabled>请选择…</option>
          {patients.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
        </select>
        {!med && <div className="banner info" style={{ marginTop: 12 }}>
          药师仅可见与用药安全相关的字段：过敏史、用药计划、用药医嘱与依从性；
          症状描述、体温血压、上报图片及非用药医嘱内容均不可见，也不能修改诊疗结论。
        </div>}
        {med && (
          <>
            <h3 style={{ marginTop: 14 }}>在院用药计划</h3>
            <table>
              <tbody>
                {med.plans.map((m: any) => (
                  <tr key={m.id}><td>{m.drug_name}</td><td>{m.dosage}</td>
                    <td>{m.frequency}</td><td><StatusTag status={m.active ? "active" : "cancelled"} /></td></tr>
                ))}
              </tbody>
            </table>
            <h3 style={{ marginTop: 12 }}>用药医嘱（含自动相互作用校验）</h3>
            {med.auto_interactions.length > 0 && (
              <div className="banner danger">
                系统检出相互作用：
                <ul style={{ margin: "6px 0 0 18px" }}>
                  {med.auto_interactions.map((x: string, i: number) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            )}
            <table>
              <tbody>
                {med.orders.map((o: any) => (
                  <tr key={o.id} style={{ opacity: o.status === "withdrawn" ? 0.55 : 1 }}>
                    <td>{o.content}
                      {o.status === "withdrawn" && <div className="tag red">医嘱已撤回</div>}</td>
                    <td><StatusTag status={o.status} /> <StatusTag status={o.pharmacy_status} /></td>
                    <td><input type="radio" name="ord" checked={form.order_id === o.id}
                               disabled={o.status === "withdrawn"}
                               onChange={() => setForm({ ...form, order_id: o.id,
                                 detail: med.auto_interactions.join("；") })} /></td>
                  </tr>
                ))}
                {med.orders.length === 0 && <tr><td className="muted">暂无用药医嘱</td></tr>}
              </tbody>
            </table>
            <button style={{ marginTop: 8 }} onClick={() => onOpen(pid)}>查看脱敏后的患者时间线 →</button>
          </>
        )}
      </div>

      <div className="panel">
        <h3>药师审方意见</h3>
        <label style={{ marginTop: 0 }}>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input style={{ width: "auto" }} type="checkbox" checked={form.found}
                   onChange={(e) => setForm({ ...form, found: e.target.checked })} />
            存在用药相互作用 / 用药风险
          </span>
        </label>
        <label>相互作用说明</label>
        <textarea value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })}
                  placeholder="如：华法林 × 阿司匹林，INR 升高、出血风险增加" />
        <label>用药建议（仅建议，不替代医生医嘱）</label>
        <textarea value={form.advice} onChange={(e) => setForm({ ...form, advice: e.target.value })}
                  placeholder="如：建议医生评估是否联用，必要时加强 INR 监测" />
        <button className="primary" style={{ marginTop: 12 }} disabled={!pid}
                onClick={submit}>提交审方</button>
        <p className="muted" style={{ marginTop: 12 }}>
          提交后仅生成药师审方记录、更新医嘱的“审方流转标记”并通知医生；
          医嘱内容与状态（生效/撤回）只能由医生修改。
        </p>
      </div>
    </div>
  );
}

function Picker({ onPick }: any) {
  const [ps, setPs] = useState<any[]>([]);
  useEffect(() => { api("/staff/patients").then(setPs); }, []);
  return (
    <div className="panel">
      <h3>患者列表（药师视角）</h3>
      <table>
        <thead><tr><th>病案号</th><th>姓名（脱敏）</th><th>科室</th><th>手术</th><th></th></tr></thead>
        <tbody>
          {ps.map((p) => (
            <tr key={p.id}>
              <td>{p.code}</td><td>{p.name}</td><td>{p.department}</td>
              <td>{p.surgery_type}</td>
              <td><button onClick={() => onPick(p.id)}>时间线</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
