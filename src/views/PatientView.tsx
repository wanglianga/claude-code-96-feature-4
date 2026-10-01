import { useEffect, useRef, useState } from "react";
import { api, newIdempotencyKey } from "../api";
import { LevelTag, StatusTag, fmt } from "../components/ui";

const SYMPTOMS = [
  "胸痛", "胸闷", "呼吸困难", "伤口出血", "呕血", "黑便",
  "伤口流脓", "刀口裂开", "意识模糊", "全身风团", "面唇肿胀",
  "发热", "轻微乏力", "伤口红肿",
];

export default function PatientView({ user, notify }: any) {
  const [tab, setTab] = useState<"report" | "tasks" | "timeline">("report");
  return (
    <>
      <div className="topbar" style={{ borderBottom: "none", background: "transparent",
        position: "static", paddingTop: 14 }}>
        <div className="tabs" style={{ maxWidth: 1180, margin: "0 auto" }}>
          {[["report", "症状上报"], ["tasks", "我的随访"], ["timeline", "我的时间线"]].map(
            ([k, label]) => (
              <button key={k} className={tab === k ? "active" : ""}
                      onClick={() => setTab(k as any)}>{label}</button>
            )
          )}
        </div>
      </div>
      <div className="page">
        {tab === "report" && <ReportForm notify={notify} />}
        {tab === "tasks" && <MyTasks />}
        {tab === "timeline" && <MyTimeline />}
      </div>
    </>
  );
}

function ReportForm({ notify }: any) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [temp, setTemp] = useState("");
  const [bp, setBp] = useState({ s: "", d: "" });
  const [adherence, setAdherence] = useState("full");
  const [contactOk, setContactOk] = useState(true);
  const [channel, setChannel] = useState("portal");
  const [images, setImages] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);
  // 幂等键在表单“生命周期”内固定：双击/网络重试/多入口同表单都不会重复
  const keyRef = useRef(newIdempotencyKey());
  const fileRef = useRef<HTMLInputElement>(null);

  const toggle = (s: string) =>
    setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));

  const upload = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const img = await api("/patient/images", { method: "POST", form: fd });
        setImages((xs) => [...xs, img]);
        if (img.status === "unreadable")
          notify("err", `图片“${img.filename}”无法读取（${img.unreadable_reason}），已记录并转人工`);
      } catch (e: any) {
        notify("err", `图片上传失败：${e.message}`);
      }
    }
  };

  const submit = async () => {
    if (submitting) return; // 防重复点击
    setSubmitting(true);
    try {
      const body = {
        symptoms: picked,
        symptom_text: text,
        temperature: temp ? Number(temp) : null,
        systolic: bp.s ? Number(bp.s) : null,
        diastolic: bp.d ? Number(bp.d) : null,
        adherence,
        contact_ok: contactOk,
        channel,
        image_ids: images.map((i) => i.id),
        idempotency_key: keyRef.current,
      };
      const r = await api("/patient/reports", { method: "POST", body });
      setResult(r);
      notify("ok", r.message);
      if (!r.duplicate && r.created) {
        // 提交成功后换新键，允许下一次全新上报
        keyRef.current = newIdempotencyKey();
        setPicked([]); setText(""); setTemp(""); setBp({ s: "", d: "" });
        setImages([]);
        if (fileRef.current) fileRef.current.value = "";
      }
    } catch (e: any) {
      notify("err", e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid2">
      <div className="panel">
        <h3>提交出院后情况</h3>
        <label>症状（可多选）</label>
        <div className="checklist">
          {SYMPTOMS.map((s) => (
            <label key={s}>
              <input type="checkbox" checked={picked.includes(s)} onChange={() => toggle(s)} />
              {s}
            </label>
          ))}
        </div>
        <label>症状描述</label>
        <textarea value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="请描述开始时间、程度、持续情况…" />
        <div className="row">
          <div>
            <label>体温（℃）</label>
            <input value={temp} type="number" step="0.1" onChange={(e) => setTemp(e.target.value)} />
          </div>
          <div>
            <label>收缩压</label>
            <input value={bp.s} type="number" onChange={(e) => setBp({ ...bp, s: e.target.value })} />
          </div>
          <div>
            <label>舒张压</label>
            <input value={bp.d} type="number" onChange={(e) => setBp({ ...bp, d: e.target.value })} />
          </div>
        </div>
        <div className="row">
          <div>
            <label>用药依从性</label>
            <select value={adherence} onChange={(e) => setAdherence(e.target.value)}>
              <option value="full">全部按时服用</option>
              <option value="partial">有漏服/减量</option>
              <option value="none">自行停药</option>
              <option value="unknown">不适用</option>
            </select>
          </div>
          <div>
            <label>上报入口</label>
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="portal">网页门户</option>
              <option value="mini_app">小程序</option>
              <option value="sms">短信</option>
            </select>
          </div>
        </div>
        <label style={{ marginTop: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input style={{ width: "auto" }} type="checkbox" checked={contactOk}
                   onChange={(e) => setContactOk(e.target.checked)} />
            我同意护士通过电话与我联系（不勾选将转人工跟进）
          </span>
        </label>
        <label>伤口/药品图片（JPEG/PNG，损坏文件会被识别并转人工）</label>
        <input ref={fileRef} type="file" accept="image/*" multiple
               onChange={(e) => upload(e.target.files)} />
        <div style={{ marginTop: 8 }}>
          {images.map((i) => (
            <span key={i.id} className={`tag ${i.status === "ok" ? "green" : "red"}`}
                  style={{ marginRight: 6 }}>
              {i.filename} · {i.status === "ok" ? "已接收" : "无法读取"}
            </span>
          ))}
        </div>
        <button className="primary" style={{ marginTop: 16, width: "100%" }}
                disabled={submitting || (!picked.length && !text && !temp && !bp.s && !images.length)}
                onClick={submit}>
          {submitting ? "提交中，请勿重复点击…" : "提 交 上 报"}
        </button>
      </div>

      <div className="panel">
        <h3>提交结果与规则提示</h3>
        {!result && (
          <div className="banner info">
            系统将根据症状与体征自动评估：触发胸痛/呼吸困难、活动性出血、高热（≥39℃）、
            血压危急值等规则时，会<b>立即冻结常规随访并通知护士</b>，请保持电话畅通。
          </div>
        )}
        {result && (
          <>
            <div className={`banner ${result.high_risk ? "danger" : "info"}`}>{result.message}</div>
            <dl className="kv">
              <dt>上报编号</dt><dd>#{result.report.id}</dd>
              <dt>处理状态</dt><dd><StatusTag status={result.report.status} /></dd>
              <dt>高风险</dt><dd>{result.high_risk ? "是，已创建升级任务" : "否"}</dd>
              <dt>升级单</dt><dd>{result.escalation_id ? `#${result.escalation_id}` : "—"}</dd>
              {result.duplicate && <>
                <dt>去重</dt><dd>与上报 #{result.report.duplicate_of_id} 合并，未重复分诊
                </dd>
              </>}
            </dl>
          </>
        )}
        <h3 style={{ marginTop: 18 }}>我的随访任务</h3>
        <MyTasks compact />
      </div>
    </div>
  );
}

function MyTasks({ compact }: { compact?: boolean }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api("/patient/overview").then(setData); }, []);
  if (!data) return <div className="muted">加载中…</div>;
  return (
    <div className="panel">
      {!compact && <h3>{data.patient.name}（{data.patient.code}）· {data.patient.surgery_type}</h3>}
      <dl className="kv">
        <dt>出院日期</dt><dd>{data.patient.discharge_date}</dd>
        <dt>过敏史</dt><dd>{data.patient.allergy}</dd>
        <dt>授权有效期</dt><dd>{fmt(data.patient.consent_until)}</dd>
      </dl>
      <table style={{ marginTop: 10 }}>
        <thead><tr><th>级别</th><th>任务</th><th>应办时间</th><th>状态</th></tr></thead>
        <tbody>
          {data.tasks.map((t: any) => (
            <tr key={t.id}>
              <td><LevelTag level={t.level} /></td>
              <td>{t.title}<div className="muted">{t.reason}</div></td>
              <td>{fmt(t.due_at)}</td>
              <td><StatusTag status={t.status} />
                {t.cancel_reason && <div className="muted">{t.cancel_reason}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MyTimeline() {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => { api("/patient/overview").then((d) => setId(d.patient?.id ?? null)); }, []);
  if (id == null) return <div className="muted">加载中…</div>;
  return <PatientTimeline patientId={id} />;
}

// 患者访问自己的时间线（后端对 patient 角色放行本人）
function PatientTimeline({ patientId }: { patientId: number }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api(`/staff/patients/${patientId}/timeline`).then(setData).catch(() => setData({ events: [] }));
  }, [patientId]);
  if (!data) return <div className="muted">加载中…</div>;
  return (
    <div className="panel">
      <h3>我的完整处置时间线</h3>
      <p className="muted">您的每次上报、护士分诊、医生医嘱、转诊与关闭依据都在此可追溯。</p>
      <div className="tl">
        {data.events.map((ev: any) => (
          <div key={ev.id} className="tl-item">
            <div className="tl-time">{fmt(ev.event_time)}</div>
            <div className="tl-summary"><b>{ev.actor_name}</b>：{ev.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
