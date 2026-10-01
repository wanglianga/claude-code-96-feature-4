import { useEffect, useState } from "react";
import { api } from "../api";
import Timeline from "../components/Timeline";
import { LevelTag, StatusTag, fmt } from "../components/ui";

export default function NurseView({ user, notify, admin }: any) {
  const [tab, setTab] = useState(
    admin ? "queue" : "esc"
  );
  const [patientId, setPatientId] = useState<number | null>(null);

  const tabs: [string, string][] = [
    ["esc", "高风险升级台"],
    ["tasks", "随访任务板"],
    ["reports", "患者上报流"],
    ["queue", "人工队列"],
    ["patients", "患者档案 / 时间线"],
    ...(admin ? ([["ops", "通知与巡检"]] as [string, string][]) : []),
  ];

  return (
    <>
      <SubTabs tabs={tabs} current={tab} onChange={setTab} />
      <div className="page">
        {patientId ? (
          <PatientFolder pid={patientId} onBack={() => setPatientId(null)} notify={notify} />
        ) : (
          <>
            {tab === "esc" && <EscBoard notify={notify} onOpenPatient={setPatientId} />}
            {tab === "tasks" && <TaskBoard notify={notify} />}
            {tab === "reports" && <ReportsFeed onOpenPatient={setPatientId} />}
            {tab === "queue" && <QueueBoard notify={notify} />}
            {tab === "patients" && <PatientPicker onPick={setPatientId} />}
            {tab === "ops" && <OpsPanel notify={notify} />}
          </>
        )}
      </div>
    </>
  );
}

export function SubTabs({ tabs, current, onChange }: any) {
  return (
    <div className="topbar" style={{ borderBottom: "none", background: "transparent",
      position: "static", paddingTop: 14 }}>
      <div className="tabs" style={{ maxWidth: 1180, margin: "0 auto" }}>
        {tabs.map(([k, label]: [string, string]) => (
          <button key={k} className={current === k ? "active" : ""}
                  onClick={() => onChange(k)}>{label}</button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- 高风险升级台 ---------------- */

function EscBoard({ notify, onOpenPatient }: any) {
  const [list, setList] = useState<any[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);

  const load = () => api("/staff/escalations?active_only=true").then(setList);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (sel == null) { setDetail(null); return; }
    api(`/staff/escalations/${sel}`).then(setDetail);
  }, [sel]);

  return (
    <div className={sel ? "" : "grid2"}>
      <div className="panel">
        <h3>进行中的升级单（{list.length}）</h3>
        {list.length === 0 && <div className="muted">暂无进行中的高风险事件 🎉</div>}
        <table>
          <thead><tr><th>#</th><th>患者</th><th>风险</th><th>SLA</th><th>状态</th></tr></thead>
          <tbody>
            {list.map((e) => {
              const overdue = e.sla_due_at && new Date(e.sla_due_at) < new Date();
              return (
                <tr key={e.id} className="clickable" onClick={() => setSel(e.id)}
                    style={{ background: sel === e.id ? "#f0f7ff" : undefined }}>
                  <td>#{e.id}</td>
                  <td>{e.patient?.name}
                    <div className="muted">{e.patient?.code} · {e.patient?.surgery_type}</div></td>
                  <td>{e.risk_summary || "—"}</td>
                  <td className={overdue ? "" : ""}>
                    <span className={overdue ? "tag red" : "muted"}>{fmt(e.sla_due_at)}</span>
                    {e.reminder_count > 0 &&
                      <div className="tag red" style={{ marginTop: 3 }}>超时提醒×{e.reminder_count}</div>}
                  </td>
                  <td><StatusTag status={e.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {sel && detail && (
        <EscDetail esc={detail}
                   onChanged={() => { api(`/staff/escalations/${sel}`).then(setDetail); load(); }}
                   onOpenPatient={onOpenPatient} notify={notify} />
      )}
    </div>
  );
}

function EscDetail({ esc, onChanged, onOpenPatient, notify }: any) {
  const [action, setAction] = useState("phone_callback");
  const [note, setNote] = useState("");
  const [target, setTarget] = useState("心内科");
  const [reached, setReached] = useState(true);
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  const [basis, setBasis] = useState("");
  const [disposition, setDisposition] = useState("auto");

  const submitAction = async () => {
    setBusy(true);
    try {
      const r = await api(`/nurse/escalations/${esc.id}/screen`, {
        method: "POST",
        body: { action, note, target, reached, outcome },
      });
      notify("ok", `初筛已提交（${r.status}）${r.referral_created === false ? "，转诊单已存在，未重复创建" : ""}`);
      setNote(""); setOutcome("");
      onChanged();
    } catch (e: any) { notify("err", e.message); }
    finally { setBusy(false); }
  };

  const decide = async (refId: number, decision: string) => {
    const n2 = prompt(decision === "confirm" ? "确认转诊备注" : "驳回原因") || "";
    try {
      await api(`/doctor/referrals/${refId}/decision`, {
        method: "POST", body: { decision, note: n2 },
      });
      notify("ok", "转诊已" + (decision === "confirm" ? "确认" : "驳回"));
      onChanged();
    } catch (e: any) {
      // 护士无医生权限时会 403，提示需医生处理
      notify("err", `需要医生/管理员账号确认转诊：${e.message}`);
    }
  };

  const close = async () => {
    try {
      await api(`/nurse/escalations/${esc.id}/close`, {
        method: "POST", body: { basis, frozen_disposition: disposition },
      });
      notify("ok", "升级单已关闭");
      setBasis(""); onChanged();
    } catch (e: any) { notify("err", e.message); }
  };

  return (
    <div className="panel">
      <h3>升级单 #{esc.id} · {esc.patient?.name} <StatusTag status={esc.status} /></h3>
      <div className="banner danger">{esc.risk_summary}
        <div className="muted" style={{ color: "inherit" }}>开启 {fmt(esc.opened_at)} · SLA {fmt(esc.sla_due_at)}</div>
      </div>

      <h3>关联上报（{esc.reports.length}）</h3>
      {esc.reports.map((r: any) => (
        <div key={r.id} className="panel" style={{ boxShadow: "none", marginBottom: 8 }}>
          <div>
            <span className="tag blue">{r.channel}</span>{" "}
            <StatusTag status={r.status} />
            {r.high_risk && <span className="tag red">高风险</span>}
            <span className="muted" style={{ marginLeft: 8 }}>{fmt(r.event_time)}</span>
          </div>
          <div style={{ margin: "6px 0" }}>
            {r.symptoms.map((s: string) => <span key={s} className="tag red" style={{ marginRight: 5 }}>{s}</span>)}
          </div>
          {r.symptom_text && <div>{r.symptom_text}</div>}
          <div className="muted">
            体温 {r.temperature ?? "—"}℃ · 血压 {r.systolic ?? "—"}/{r.diastolic ?? "—"}
            · 用药依从 {({full:"全部按时",partial:"有漏服",none:"已停药",unknown:"不适用"} as any)[r.adherence]}
          </div>
          {r.images?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {r.images.map((i: any) => (
                <span key={i.id} style={{ marginRight: 10 }}>
                  {i.url
                    ? <a href={i.url} target="_blank" rel="noreferrer">📎 {i.filename}</a>
                    : <span className="tag red">图片不可读：{i.unreadable_reason}</span>}
                </span>
              ))}
            </div>
          )}
          {r.risk_hits?.map((h: any) => (
            <span key={h.code} className="tag red" style={{ marginRight: 5 }}>
              ⚠ {h.label}{h.value ? ` ${h.value}` : ""}
            </span>
          ))}
        </div>
      ))}

      <h3>护士初筛动作</h3>
      <div className="checklist" style={{ marginBottom: 6 }}>
        {[["phone_callback", "📞 电话回访"], ["ed_advice", "🚑 急诊建议"],
          ["referral_request", "↗ 转诊申请"], ["note", "📝 仅备注"]].map(([v, l]) => (
          <label key={v} className={action === v ? "tag blue" : ""}>
            <input type="radio" name="act" checked={action === v}
                   onChange={() => setAction(v)} />{l}
          </label>
        ))}
      </div>
      {action === "referral_request" && (
        <input placeholder="目标科室/医院，如 心内科 / 市第一人民医院急诊"
               value={target} onChange={(e) => setTarget(e.target.value)} />
      )}
      {action === "phone_callback" && (
        <div className="row" style={{ marginTop: 6 }}>
          <select value={String(reached)} onChange={(e) => setReached(e.target.value === "true")}>
            <option value="true">已联系到患者</option>
            <option value="false">未联系到</option>
          </select>
          <input placeholder="回访结论" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        </div>
      )}
      <textarea style={{ marginTop: 8 }} placeholder="记录（未联系到/拒接会自动转人工队列）"
                value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="primary" disabled={busy} style={{ marginTop: 8 }}
              onClick={submitAction}>提交初筛</button>

      <h3 style={{ marginTop: 16 }}>转诊单</h3>
      {esc.referrals.length === 0 && <div className="muted">暂无转诊</div>}
      {esc.referrals.map((r: any) => (
        <div key={r.id} className="panel" style={{ boxShadow: "none" }}>
          #{r.id} → {r.target} <StatusTag status={r.status} />
          <div className="muted">申请人 {r.requested_by} · {fmt(r.request_event_time)} · {r.reason}</div>
          {r.status === "requested" && (
            <div style={{ marginTop: 6 }}>
              <button className="primary" onClick={() => decide(r.id, "confirm")}>医生确认</button>{" "}
              <button className="danger" onClick={() => decide(r.id, "reject")}>驳回</button>
              <span className="muted" style={{ marginLeft: 8 }}>（需医生权限）</span>
            </div>
          )}
          {r.confirmation_note && <div className="muted">备注：{r.confirmation_note}</div>}
        </div>
      ))}

      <h3>已记录初筛/回访</h3>
      {[...esc.triage_actions, ...esc.callbacks.map((c: any) => ({ ...c, action: "phone_callback" }))]
        .sort((a, b) => a.event_time.localeCompare(b.event_time))
        .map((a: any) => (
          <div key={`${a.action}-${a.id}`} className="muted" style={{ marginBottom: 4 }}>
            {fmt(a.event_time)} {a.nurse_name} · {a.action}
            {"outcome" in a ? ` · ${a.reached ? "已联系" : "未联系"} ${a.outcome ?? ""}` : ""}
            {a.note ? ` · ${a.note}` : ""}
          </div>
        ))}

      <h3 style={{ marginTop: 16 }}>关闭升级单</h3>
      {esc.status === "referral_requested" && (
        <div className="banner warn">转诊尚未确认，不能关闭；请先由医生确认/驳回转诊。</div>
      )}
      <div className="row">
        <select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
          <option value="auto">冻结任务自动处置（未到期恢复，到期取消）</option>
          <option value="resume">全部恢复普通随访</option>
          <option value="cancel">全部取消（由升级随访替代）</option>
        </select>
        <input placeholder="关闭依据（必填）" value={basis} onChange={(e) => setBasis(e.target.value)} />
      </div>
      <button className="primary" style={{ marginTop: 8 }} disabled={!basis || esc.status === "referral_requested"}
              onClick={close}>关闭并留痕</button>
      <div style={{ marginTop: 10 }}>
        <button onClick={() => onOpenPatient(esc.patient_id)}>查看患者完整时间线 →</button>
      </div>
    </div>
  );
}

/* ---------------- 任务板 ---------------- */

function TaskBoard({ notify }: any) {
  const [tasks, setTasks] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const load = () => api("/staff/tasks" + (filter ? `?status=${filter}` : "")).then(setTasks);
  useEffect(() => { load(); }, [filter]);

  const act = async (id: number, kind: "start" | "complete") => {
    let body: any = {};
    if (kind === "complete") {
      const basis = prompt("请填写完成依据（必填）") || "";
      if (!basis) return;
      body = { basis };
    }
    try {
      await api(`/nurse/tasks/${id}/${kind}`, { method: "POST", body });
      notify("ok", "任务已" + (kind === "start" ? "开始" : "完成"));
      load();
    } catch (e: any) { notify("err", e.message); }
  };

  return (
    <div className="panel">
      <h3>分级随访任务板
        <select style={{ width: 150, marginLeft: 12, display: "inline-block" }}
                value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="scheduled">待执行</option>
          <option value="in_progress">进行中</option>
          <option value="frozen">已冻结</option>
          <option value="completed">已完成</option>
          <option value="cancelled">已取消</option>
        </select>
      </h3>
      <table>
        <thead><tr><th>级别</th><th>患者</th><th>任务</th><th>应办</th><th>状态</th><th>替代/取消</th><th></th></tr></thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td><LevelTag level={t.level} /></td>
              <td>{t.patient?.name}<div className="muted">{t.patient?.code}</div></td>
              <td>{t.title}<div className="muted">{t.reason}</div></td>
              <td>{fmt(t.due_at)}</td>
              <td><StatusTag status={t.status} /></td>
              <td className="muted">
                {t.superseded_by_order_id && <div>被医嘱 #{t.superseded_by_order_id} 替代</div>}
                {t.cancel_reason && <div>{t.cancel_reason}</div>}
                {t.closure_basis && <div>{t.closure_basis}</div>}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                {t.status === "scheduled" && <button onClick={() => act(t.id, "start")}>开始</button>}
                {(t.status === "scheduled" || t.status === "in_progress") &&
                  <button className="primary" style={{ marginLeft: 6 }}
                          onClick={() => act(t.id, "complete")}>完成</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- 上报流 ---------------- */

function ReportsFeed({ onOpenPatient }: any) {
  const [reports, setReports] = useState<any[]>([]);
  useEffect(() => { api("/staff/reports").then(setReports); }, []);
  return (
    <div className="panel">
      <h3>患者上报流（按业务时间倒序）</h3>
      <table>
        <thead><tr><th>时间</th><th>患者</th><th>入口</th><th>症状/体征</th><th>依从</th><th>附件</th><th>状态</th></tr></thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => onOpenPatient(r.patient.id)}>
              <td>{fmt(r.event_time)}</td>
              <td>{r.patient?.name}<div className="muted">{r.patient?.code}</div></td>
              <td><span className="tag blue">{r.channel}</span>
                {r.duplicate_of_id && <div className="tag gray">合并→#{r.duplicate_of_id}</div>}</td>
              <td>
                {r.symptoms.map((s: string) => <span key={s} className="tag red" style={{ marginRight: 4 }}>{s}</span>)}
                {r.temperature && <span className="tag gray">T {r.temperature}℃</span>}{" "}
                {r.systolic && <span className="tag gray">BP {r.systolic}/{r.diastolic}</span>}
                {r.symptom_text && <div className="muted">{r.symptom_text}</div>}
              </td>
              <td>{r.adherence}</td>
              <td>{r.images.length === 0 ? "—" : r.images.map((i: any) =>
                i.url ? <a key={i.id} href={i.url} target="_blank" rel="noreferrer">📎</a>
                      : <span key={i.id} className="tag red">损坏</span>)}</td>
              <td><StatusTag status={r.status} />
                {r.high_risk && <div className="tag red">高风险</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- 人工队列 ---------------- */

const REASON_LABEL: Record<string, string> = {
  contact_refused: "患者拒绝联系",
  consent_expired: "授权过期",
  image_unreadable: "图片无法读取",
  sla_breach: "SLA 超时未闭环",
  notify_dead: "通知投递失败",
  other: "其他",
};

export function QueueBoard({ notify }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState("open");
  const load = () => api(`/queue?status=${status}`).then(setItems);
  useEffect(() => { load(); }, [status]);

  return (
    <div className="panel">
      <h3>人工队列
        <select style={{ width: 140, marginLeft: 12, display: "inline-block" }}
                value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">待处理</option>
          <option value="claimed">认领中</option>
          <option value="resolved">已解决</option>
        </select>
      </h3>
      {items.length === 0 && <div className="muted">队列中没有事项</div>}
      <table>
        <thead><tr><th>时间</th><th>患者</th><th>原因</th><th>详情</th><th>状态</th><th></th></tr></thead>
        <tbody>
          {items.map((q) => (
            <tr key={q.id}>
              <td>{fmt(q.created_at)}</td>
              <td>{q.patient?.name} <span className="muted">{q.patient?.code}</span></td>
              <td><span className="tag amber">{REASON_LABEL[q.reason_type] || q.reason_type}</span></td>
              <td style={{ maxWidth: 380 }}>{q.detail}{q.resolution && <div className="muted">处理：{q.resolution}</div>}</td>
              <td><StatusTag status={q.status} /></td>
              <td style={{ whiteSpace: "nowrap" }}>
                {q.status === "open" && <button onClick={async () => {
                  await api(`/queue/${q.id}/claim`, { method: "POST" }); notify("ok", "已认领"); load();
                }}>认领</button>}
                {q.status !== "resolved" && <button className="primary" style={{ marginLeft: 6 }} onClick={async () => {
                  const resolution = prompt("处理结果") || "";
                  if (!resolution) return;
                  await api(`/queue/${q.id}/resolve`, { method: "POST", body: { resolution } });
                  notify("ok", "已解决"); load();
                }}>解决</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- 患者档案 ---------------- */

function PatientPicker({ onPick }: any) {
  const [ps, setPs] = useState<any[]>([]);
  useEffect(() => { api("/staff/patients").then(setPs); }, []);
  return (
    <div className="panel">
      <h3>患者列表（字段按当前角色脱敏）</h3>
      <table>
        <thead><tr><th>病案号</th><th>姓名</th><th>科室</th><th>手术</th><th>出院日</th><th></th></tr></thead>
        <tbody>
          {ps.map((p) => (
            <tr key={p.id}>
              <td>{p.code}</td><td>{p.name}</td><td>{p.department}</td>
              <td>{p.surgery_type}</td><td>{p.discharge_date ?? "—"}</td>
              <td><button onClick={() => onPick(p.id)}>档案与时间线</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PatientFolder({ pid, onBack, notify }: any) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api(`/staff/patients/${pid}`).then(setData); }, [pid]);
  if (!data) return <div className="muted">加载中…</div>;
  const p = data.patient;
  return (
    <>
      <button onClick={onBack}>← 返回</button>
      <div className="grid2" style={{ marginTop: 10 }}>
        <div className="panel">
          <h3>{p.name}（{p.code}）</h3>
          <dl className="kv">
            <dt>性别/出生</dt><dd>{p.gender} · {p.birth_date}</dd>
            <dt>手机</dt><dd>{p.phone}</dd>
            <dt>身份证后4位</dt><dd><span className="mask">已隐藏</span></dd>
            <dt>科室/手术</dt><dd>{p.department} · {p.surgery_type}</dd>
            <dt>出院日期</dt><dd>{p.discharge_date}</dd>
            <dt>出院医嘱</dt><dd>{p.discharge_orders}</dd>
            <dt>过敏史</dt><dd>{p.allergy}</dd>
            <dt>随访授权</dt><dd>至 {fmt(p.consent_until)}
              {p.contact_refused && <span className="tag red" style={{ marginLeft: 6 }}>拒绝电话联系</span>}</dd>
          </dl>
          <h3 style={{ marginTop: 14 }}>用药计划</h3>
          <table>
            <tbody>
              {data.medications.map((m: any) => (
                <tr key={m.id}><td>{m.drug_name}</td><td>{m.dosage}</td>
                  <td>{m.frequency}</td><td>{m.start_date} ~ {m.end_date}</td></tr>
              ))}
            </tbody>
          </table>
          <h3 style={{ marginTop: 14 }}>随访任务（含取消/替代关系）</h3>
          <table>
            <tbody>
              {data.tasks.map((t: any) => (
                <tr key={t.id}>
                  <td><LevelTag level={t.level} /></td><td>{t.title}</td>
                  <td>{fmt(t.due_at)}</td><td><StatusTag status={t.status} /></td>
                  <td className="muted">{t.cancel_reason || t.closure_basis || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>事件时间线（按业务时间，可追溯）</h3>
          <Timeline patientId={pid} />
        </div>
      </div>
    </>
  );
}

/* ---------------- 运维（通知/巡检） ---------------- */

function OpsPanel({ notify }: any) {
  const [notes, setNotes] = useState<any[]>([]);
  const load = () => api("/queue/notifications").then(setNotes);
  useEffect(() => { load(); }, []);
  return (
    <div className="panel">
      <h3>异步通知与后台巡检</h3>
      <button className="primary" onClick={async () => {
        const r = await api("/queue/sweep", { method: "POST" });
        notify("ok", "巡检完成：" + JSON.stringify(r));
        load();
      }}>立即执行一次巡检（投递通知 / SLA 提醒 / 死信转人工）</button>
      <table style={{ marginTop: 12 }}>
        <thead><tr><th>类型</th><th>标题</th><th>状态</th><th>尝试</th><th>下次重试</th><th>错误</th></tr></thead>
        <tbody>
          {notes.map((n) => (
            <tr key={n.id}>
              <td>{n.ntype}</td><td>{n.title}</td>
              <td><StatusTag status={n.status} /></td>
              <td>{n.attempts}/{n.max_attempts}</td>
              <td>{fmt(n.next_attempt_at)}</td>
              <td className="muted">{n.last_error}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
