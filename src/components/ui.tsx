export function fmt(iso?: string | null) {
  if (!iso) return "—";
  return iso.replace("T", " ").replace("Z", "").slice(0, 16);
}

const STATUS: Record<string, [string, string]> = {
  scheduled: ["待执行", "gray"],
  in_progress: ["进行中", "blue"],
  frozen: ["已冻结", "amber"],
  completed: ["已完成", "green"],
  cancelled: ["已取消", "gray"],
  // escalation
  open: ["待初筛", "red"],
  phone_followup: ["电话回访中", "blue"],
  ed_advised: ["已建议急诊", "amber"],
  referral_requested: ["转诊待确认", "amber"],
  referral_confirmed: ["转诊已确认", "purple"],
  closed: ["已关闭", "green"],
  // referral
  requested: ["待确认", "amber"],
  confirmed: ["已确认", "green"],
  rejected: ["已驳回", "red"],
  // report
  new: ["新建", "blue"],
  merged: ["已合并", "gray"],
  triaged: ["已分诊", "green"],
  // order
  active: ["生效中", "green"],
  withdrawn: ["已撤回", "red"],
  // queue
  claimed: ["处理中", "blue"],
  resolved: ["已解决", "green"],
  // misc
  ok: ["可读", "green"],
  unreadable: ["无法读取", "red"],
  pending: ["待处理", "amber"],
  sent: ["已送达", "green"],
  failed: ["重试中", "amber"],
  dead: ["投递失败", "red"],
  dead_queued: ["已转人工", "gray"],
  reviewed: ["审方通过", "green"],
  interaction_flag: ["相互作用预警", "red"],
  not_required: ["无需审方", "gray"],
};

export function StatusTag({ status }: { status: string }) {
  const [text, cls] = STATUS[status] || [status, "gray"];
  return <span className={`tag ${cls}`}>{text}</span>;
}

export const LEVEL: Record<string, [string, string]> = {
  L1: ["L1 常规", "green"],
  L2: ["L2 中风险", "amber"],
  L3: ["L3 高风险", "red"],
  ESC: ["升级", "red"],
  MANUAL: ["人工", "blue"],
};

export function LevelTag({ level }: { level: string }) {
  const [text, cls] = LEVEL[level] || [level, "gray"];
  return <span className={`tag ${cls}`}>{text}</span>;
}
