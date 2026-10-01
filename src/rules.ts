import type { Patient, Report, RiskLevel, Role, TriageLevel, Channel } from './types';

// ============ 工具 ============
export const uid = (p = 'id'): string =>
  `${p}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;

export const iso = (d: Date | string): string => new Date(d).toISOString();

export const fmt = (isoStr?: string): string => {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const hoursBetween = (a: string, b: string): number =>
  (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

/** 出院后第 N 天的时刻（用于排期；锚定出院日 09:00） */
export const postDischarge = (dischargeDate: string, day: number, hour = 9): string => {
  const d = new Date(dischargeDate);
  d.setDate(d.getDate() + day);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

// ============ 高风险规则引擎 ============
export interface RuleHit {
  level: RiskLevel;
  rules: string[];
}

const HIGH_SYMPTOMS = new Set([
  '呼吸困难', '胸痛胸闷', '意识模糊', '伤口大量渗血', '呕血黑便',
  '持续高热', '剧烈腹痛', '抽搐', '单侧肢体无力',
]);
const MEDIUM_SYMPTOMS = new Set([
  '发热', '伤口红肿渗液', '呕吐', '明显疼痛加重', '排尿困难', '皮疹瘙痒', '心慌心悸',
]);

const DRUG_INTERACTIONS: [RegExp, RegExp, string, string, 'warning' | 'critical'][] = [
  [/华法林/, /阿司匹林/, '华法林 + 阿司匹林', '显著增加出血风险，需立即复核凝血指标并由医生评估是否调整抗栓方案', 'critical'],
  [/华法林/, /布洛芬/, '华法林 + 布洛芬(NSAID)', '增加胃肠出血风险并增强抗凝作用，建议避免联用', 'critical'],
  [/头孢/, /酒精|藿香正气水/, '头孢类 + 含酒精制剂', '可能引发双硫仑样反应，禁止同服并核查患者其他中成药', 'critical'],
  [/左氧氟沙星/, /钙|铁|抗酸/, '喹诺酮 + 含钙/铁/抗酸剂', '同服显著降低吸收，建议间隔至少 2 小时', 'warning'],
  [/降压|缬沙坦|氨氯地平/, /布洛芬/, '降压药 + 布洛芬', 'NSAID 可削弱降压效果并增加肾损伤风险', 'warning'],
];

export interface InteractionHit {
  pair: string;
  detail: string;
  severity: 'warning' | 'critical';
}

/** 基于患者长期用药计划 + 医嘱文本检测相互作用 */
export function detectInteractions(patient: Patient, extraDrugs: string[] = []): InteractionHit[] {
  const all = [
    ...patient.medPlan.map((m) => m.drug),
    ...extraDrugs,
  ];
  const hits: InteractionHit[] = [];
  for (const [a, b, pair, detail, severity] of DRUG_INTERACTIONS) {
    const hitA = all.find((x) => a.test(x));
    const hitB = all.find((x) => b.test(x));
    if (hitA && hitB && hitA !== hitB) {
      hits.push({ pair, detail, severity });
    }
  }
  return hits;
}

/** 症状/体征评估（体温单位 ℃，血压 mmHg） */
export function evaluateReport(
  patient: Patient,
  input: { symptoms: string[]; temperature?: number; systolic?: number; diastolic?: number; adherence: Report['adherence'] },
): RuleHit {
  const rules: string[] = [];
  let level: RiskLevel = 'low';

  for (const s of input.symptoms) {
    if (HIGH_SYMPTOMS.has(s)) {
      level = 'high';
      rules.push(`高危症状：${s}`);
    } else if (MEDIUM_SYMPTOMS.has(s)) {
      if (level !== 'high') level = 'medium';
      rules.push(`中风险症状：${s}`);
    }
  }
  if (input.temperature !== undefined) {
    if (input.temperature >= 39) {
      level = 'high';
      rules.push(`体温 ${input.temperature}℃ ≥ 39℃（持续高热阈值）`);
    } else if (input.temperature >= 38) {
      if (level !== 'high') level = 'medium';
      rules.push(`体温 ${input.temperature}℃ ≥ 38℃`);
    }
  }
  if (input.systolic !== undefined && input.diastolic !== undefined) {
    if (input.systolic >= 180 || input.diastolic >= 110) {
      level = 'high';
      rules.push(`血压 ${input.systolic}/${input.diastolic} mmHg 达高血压急症阈值`);
    } else if (input.systolic <= 90 || input.diastolic <= 50) {
      level = 'high';
      rules.push(`血压 ${input.systolic}/${input.diastolic} mmHg 提示低血压/休克风险`);
    } else if (input.systolic >= 160 || input.diastolic >= 100) {
      if (level !== 'high') level = 'medium';
      rules.push(`血压 ${input.systolic}/${input.diastolic} mmHg 明显升高`);
    }
  }
  if (input.adherence === 'none') {
    if (level === 'low') level = 'medium';
    rules.push('用药完全未依从');
  }
  // 过敏史联动：皮疹/过敏样症状且患者有药物过敏史 → 升级
  if (input.symptoms.some((s) => /皮疹|瘙痒|呼吸困难/.test(s)) && patient.allergies.length > 0) {
    rules.push(`症状与过敏史（${patient.allergies.map((a) => a.drug).join('、')}）需鉴别`);
  }
  if (rules.length === 0) rules.push('未命中异常规则（常规随访）');
  return { level, rules };
}

/** 分级随访任务生成：患者身份 + 手术类型 + 出院医嘱 + 用药计划 */
export function gradePatient(patient: Patient): {
  level: TriageLevel;
  reasons: string[];
  scheduleDays: number[];
} {
  const reasons: string[] = [];
  let score = 0;
  const highRiskSurgery = /心脏|颅脑|关节置换|肿瘤|器官移植|大血管/;
  const midRiskSurgery = /腹腔镜|胆囊|甲状腺|乳腺|子宫/;
  if (highRiskSurgery.test(patient.surgeryType)) {
    score += 2;
    reasons.push(`高风险手术类型：${patient.surgeryType}`);
  } else if (midRiskSurgery.test(patient.surgeryType)) {
    score += 1;
    reasons.push(`中风险手术类型：${patient.surgeryType}`);
  }
  if (/抗凝|华法林|监测血压|控制感染|禁食/.test(patient.dischargeOrders.join('；'))) {
    score += 1;
    reasons.push('出院医嘱含高风险随访要求（抗凝/血压/感染等）');
  }
  if (patient.allergies.length > 0) {
    score += 1;
    reasons.push(`存在药物过敏史（${patient.allergies.map((a) => a.drug).join('、')}）`);
  }
  if (patient.medPlan.length >= 4) {
    score += 1;
    reasons.push(`用药计划复杂（${patient.medPlan.length} 种药品）`);
  }
  if (patient.age >= 65) {
    score += 1;
    reasons.push(`高龄患者（${patient.age} 岁）`);
  }

  let level: TriageLevel;
  if (score >= 4) {
    level = 'L3';
  } else if (score >= 2) {
    level = 'L2';
  } else {
    level = 'L1';
  }
  const scheduleDays =
    level === 'L3' ? [1, 3, 7, 14, 30] : level === 'L2' ? [1, 7, 14] : [3, 14];
  return { level, reasons, scheduleDays };
}

// ============ 字段授权与脱敏矩阵 ============
// 每个敏感字段：哪些角色可见明文；否则按规则脱敏
type FieldKey =
  | 'name' | 'phone' | 'idCardLast4' | 'age' | 'gender'
  | 'surgeryType' | 'dischargeOrders' | 'allergies' | 'medPlan'
  | 'symptoms' | 'vitals' | 'adherence' | 'images' | 'note';

// 患者本人看自己的档案不脱敏；药师不接触生命体征/症状细节以外的诊疗字段
const VISIBILITY: Record<FieldKey, Role[]> = {
  name: ['patient', 'nurse', 'doctor', 'pharmacist'], // 药师仅见脱敏姓氏
  phone: ['patient', 'nurse', 'doctor'],
  idCardLast4: ['patient', 'nurse', 'doctor'],
  age: ['patient', 'nurse', 'doctor', 'pharmacist'],
  gender: ['patient', 'nurse', 'doctor', 'pharmacist'],
  surgeryType: ['patient', 'nurse', 'doctor', 'pharmacist'],
  dischargeOrders: ['patient', 'nurse', 'doctor'], // 药师不可见完整出院诊疗医嘱
  allergies: ['patient', 'nurse', 'doctor', 'pharmacist'],
  medPlan: ['patient', 'nurse', 'doctor', 'pharmacist'],
  symptoms: ['patient', 'nurse', 'doctor', 'pharmacist'], // 药师可见用药相关症状
  vitals: ['patient', 'nurse', 'doctor'], // 药师不可见体温血压
  adherence: ['patient', 'nurse', 'doctor', 'pharmacist'],
  images: ['patient', 'nurse', 'doctor'], // 药师不可见伤口图片
  note: ['patient', 'nurse', 'doctor'],
};

const maskName = (n: string) => n.length > 1 ? n[0] + '*'.repeat(n.length - 1) : n;
const maskPhone = (p: string) => p.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
const maskId = (x: string) => `****${x}`;

export function canSee(role: Role, field: FieldKey, self: boolean): boolean {
  if (self && role === 'patient') return true;
  return VISIBILITY[field].includes(role);
}

export interface MaskedPatient {
  name: string;
  phone: string;
  idCardLast4: string;
  gender: string;
  age: number | string;
  surgeryType: string;
  dischargeOrders: string[];
  allergiesText: string;
  medPlanNames: string[];
  _role: Role;
}

export function maskPatient(patient: Patient, role: Role, self = false): MaskedPatient {
  return {
    _role: role,
    name: canSee(role, 'name', self) ? (role === 'pharmacist' ? maskName(patient.name) : patient.name) : maskName(patient.name),
    phone: canSee(role, 'phone', self) ? patient.phone : maskPhone(patient.phone),
    idCardLast4: canSee(role, 'idCardLast4', self) ? patient.idCardLast4 : maskId(patient.idCardLast4),
    gender: canSee(role, 'gender', self) ? patient.gender : '—',
    age: canSee(role, 'age', self) ? patient.age : '—',
    surgeryType: patient.surgeryType,
    dischargeOrders: canSee(role, 'dischargeOrders', self) ? patient.dischargeOrders : ['（按授权不可见完整诊疗医嘱）'],
    allergiesText: patient.allergies.map((a) => `${a.drug}（${a.reaction}）`).join('、') || '无',
    medPlanNames: patient.medPlan.map((m) => m.drug),
  };
}

/** 上报在不同角色视图下的字段投影（药师看不到血压体温与图片） */
export function visibleReportFields(role: Role): Set<string> {
  const base = new Set(['occurredAt', 'channel', 'symptoms', 'adherence', 'risk', 'triggeredRules']);
  if (role === 'patient') return new Set(['occurredAt', 'channel', 'symptoms', 'temperature', 'systolic', 'diastolic', 'adherence', 'imageIds', 'note', 'risk', 'duplicateOf']);
  if (role === 'pharmacist') {
    base.add('note');
    return base; // 无 temperature / 血压 / imageIds
  }
  // nurse / doctor 全字段
  return new Set(['occurredAt', 'recordedAt', 'channel', 'symptoms', 'temperature', 'systolic', 'diastolic', 'adherence', 'imageIds', 'imageReadable', 'note', 'risk', 'triggeredRules', 'duplicateOf']);
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  mini_app: '小程序',
  sms: '短信',
  hotline: '热线人工代录',
};

export const RISK_LABEL: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险' };
export const LEVEL_LABEL: Record<TriageLevel, string> = { L1: '一级（低）', L2: '二级（中）', L3: '三级（高）' };
