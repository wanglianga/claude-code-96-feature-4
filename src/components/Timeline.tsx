import { useEffect, useState } from "react";
import { api } from "../api";

const CATEGORY: Record<string, string> = {
  escalation: "danger",
  referral: "purple",
  order: "blue",
  pharmacy: "ok",
  task: "",
  report: "warn",
  queue: "warn",
  notification: "gray",
};

const TYPE_TONE: Record<string, string> = {
  "escalation.opened": "danger",
  "escalation.worsening": "danger",
  "escalation.sla_reminder": "warn",
  "escalation.closed": "ok",
  "report.merged": "warn",
  "order.withdrawn": "warn",
  "referral.confirmed": "ok",
  "referral.rejected": "warn",
  "task.cancelled": "warn",
  "task.completed": "ok",
  "task.resumed": "ok",
  "manual_queued": "warn",
  "manual_resolved": "ok",
};

export default function Timeline({ patientId }: { patientId: number }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");

  const load = () =>
    api(`/staff/patients/${patientId}/timeline`)
      .then(setData)
      .catch((e) => setErr(e.message));

  useEffect(() => {
    setData(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  if (err) return <div className="banner danger">{err}</div>;
  if (!data) return <div className="muted">加载时间线…</div>;

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>{data.note}</p>
      <div className="tl">
        {data.events.length === 0 && <div className="muted">暂无事件</div>}
        {data.events.map((ev: any) => {
          const tone = TYPE_TONE[ev.event_type] || CATEGORY[ev.aggregate] || "";
          return (
            <div key={ev.id} className={`tl-item ${tone}`}>
              <div className="tl-time">
                业务时间 {fmt(ev.event_time)}
                {ev.backdated && (
                  <span className="badge-backdated" title={`系统录入时间 ${fmt(ev.recorded_at)}`}>
                    补录
                  </span>
                )}
              </div>
              <div className="tl-summary">
                <span className="tl-actor">{ev.actor_name}</span>
                <span className="muted">（{actorLabel(ev.actor_type)}）</span>
                ：{ev.summary}
              </div>
              <div className="tl-meta">
                {ev.event_type} · 录入 {fmt(ev.recorded_at)}
                {ev.data && ev.data.reason ? ` · ${ev.data.reason}` : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmt(iso: string) {
  if (!iso) return "";
  return iso.replace("T", " ").replace("Z", "").slice(0, 16);
}
function actorLabel(t: string) {
  return { patient: "患者", staff: "医护", system: "系统" }[t] || t;
}
