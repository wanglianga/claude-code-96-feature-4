import type { Patient, User, BaseEvent } from './types';
import type { SystemState } from './engine';
import {
  generateFollowupPlan, submitReport, nurseScreen, resolveManualQueue,
  doctorAddOrder, withdrawOrder, pharmacistAdvice, tickSla,
} from './engine';
import type { ReportInput } from './engine';

const hoursAgo = (anchor: Date, h: number): string => new Date(anchor.getTime() - h * 3600_000).toISOString();
const daysAgo = (anchor: Date, d: number, hour = 10): string => {
  const x = new Date(anchor);
  x.setDate(x.getDate() - d);
  x.setHours(hour, 0, 0, 0);
  return x.toISOString();
};
const hoursFrom = (anchor: Date, h: number): string => new Date(anchor.getTime() + h * 3600_000).toISOString();

export const SEED_USERS: User[] = [
  { id: 'u_p1', login: 'patient1', password: '123456', name: '张建国', role: 'patient', patientId: 'p1' },
  { id: 'u_p2', login: 'patient2', password: '123456', name: '李秀兰', role: 'patient', patientId: 'p2' },
  { id: 'u_p3', login: 'patient3', password: '123456', name: '王桂芳', role: 'patient', patientId: 'p3' },
  { id: 'u_n1', login: 'nurse', password: '123456', name: '林梅（随访护士）', role: 'nurse' },
  { id: 'u_d1', login: 'doctor', password: '123456', name: '周岭（主治医生）', role: 'doctor' },
  { id: 'u_ph1', login: 'pharmacist', password: '123456', name: '陈越（临床药师）', role: 'pharmacist' },
];

export const SEED_PATIENTS: Patient[] = [
  {
    id: 'p1',
    name: '张建国', gender: '男', age: 68, phone: '13812340001', idCardLast4: '1234',
    surgeryType: '冠状动脉搭桥术（心脏大血管手术）',
    dischargeDate: daysAgo(new Date(), 9),
    dischargeOrders: ['华法林抗凝并定期监测INR', '阿司匹林抗血小板', '控制血压心率', '出院后1、3、7、14、30天随访'],
    allergies: [{ drug: '青霉素', reaction: '全身皮疹瘙痒' }],
    medPlan: [
      { id: 'm1', drug: '华法林钠片', dose: '3mg', frequency: '每日一次', startDay: 1, endDay: 90 },
      { id: 'm2', drug: '阿司匹林肠溶片', dose: '100mg', frequency: '每日一次', startDay: 1, endDay: 90 },
      { id: 'm3', drug: '阿托伐他汀钙片', dose: '20mg', frequency: '每晚一次', startDay: 1, endDay: 180 },
      { id: 'm4', drug: '美托洛尔缓释片', dose: '47.5mg', frequency: '每日一次', startDay: 1, endDay: 180 },
    ],
    consent: { validUntil: daysAgo(new Date(), -60), declinedContact: false },
  },
  {
    id: 'p2',
    name: '李秀兰', gender: '女', age: 52, phone: '13812340002', idCardLast4: '2345',
    surgeryType: '腹腔镜胆囊切除术',
    dischargeDate: daysAgo(new Date(), 6),
    dischargeOrders: ['预防感染、保持伤口干燥', '清淡低脂饮食', '一周后门诊复查'],
    allergies: [{ drug: '头孢类', reaction: '皮疹瘙痒、面部潮红' }],
    medPlan: [
      { id: 'm1', drug: '左氧氟沙星片', dose: '0.5g', frequency: '每日一次', startDay: 1, endDay: 7 },
      { id: 'm2', drug: '碳酸钙D3片', dose: '1.2g', frequency: '每日两次', startDay: 1, endDay: 30 },
      { id: 'm3', drug: '布洛芬缓释胶囊', dose: '0.3g', frequency: '必要时', startDay: 1, endDay: 5 },
    ],
    consent: { validUntil: daysAgo(new Date(), -30), declinedContact: false },
  },
  {
    id: 'p3',
    name: '王桂芳', gender: '女', age: 45, phone: '13812340003', idCardLast4: '3456',
    surgeryType: '甲状腺结节切除术',
    dischargeDate: daysAgo(new Date(), 4),
    dischargeOrders: ['定期复查甲状腺功能', '保持颈部引流通畅', '不适随诊'],
    allergies: [{ drug: '磺胺类', reaction: '皮肤水疱' }],
    medPlan: [
      { id: 'm1', drug: '左甲状腺素钠片', dose: '50μg', frequency: '每日晨起空腹一次', startDay: 1, endDay: 365 },
      { id: 'm2', drug: '对乙酰氨基酚片', dose: '0.5g', frequency: '必要时', startDay: 1, endDay: 7 },
    ],
    consent: { validUntil: daysAgo(new Date(), 2), declinedContact: false }, // 已过期
  },
];

/** 构造演示初始状态（所有历史通过命令写入，保证事件一致性） */
export function buildSeedState(now: Date): SystemState {
  const state: SystemState = {
    patients: SEED_PATIENTS,
    users: SEED_USERS,
    events: [],
    notifyChannelDown: false,
  };
  const nowIso = now.toISOString();
  const nurse = { id: 'u_n1', role: 'nurse' as const };
  const doctor = { id: 'u_d1', role: 'doctor' as const };
  const pharmacist = { id: 'u_ph1', role: 'pharmacist' as const };

  // ===== P1：高风险未闭环（超时）+ 补录医嘱 + 错误医嘱撤回恢复 + 药师相互作用 =====
  generateFollowupPlan(state, 'p1', daysAgo(now, 9));
  pharmacistAdvice(state, 'p1', pharmacist, {
    interaction: '华法林钠片 + 阿司匹林肠溶片',
    advice: '双联抗栓显著增加出血风险，建议用药教育并核对 INR；如出现黑便、牙龈出血立即就诊。药师不改诊疗方案，仅作用药提示。',
    severity: 'critical',
  }, daysAgo(now, 8));
  // 高风险上报（5 小时前）→ 升级任务（2h SLA，现已超时 3h）
  submitReport(state, 'p1', { id: 'u_p1', role: 'patient' }, {
    channel: 'mini_app',
    symptoms: ['呼吸困难', '胸痛胸闷'],
    temperature: 37.5, systolic: 152, diastolic: 95,
    adherence: 'partial',
    imageIds: [], imagesReadable: true,
    note: '上楼后明显气促，胸口发紧',
  }, hoursAgo(now, 5));
  // 医生补录医嘱：业务时间 6 小时前（早于护士可见的 5 小时前上报）→ 标记补录，且与随访计划冲突
  doctorAddOrder(state, 'p1', doctor, {
    content: '即刻暂停华法林，改低分子肝素桥接抗凝，明日上午复查INR与凝血功能',
    effectiveAt: hoursAgo(now, 6),
  }, hoursAgo(now, 4), { commandId: 'seed-p1-order-backdated' });
  // 错误医嘱：3 小时前误录，1 小时前撤回（原始记录保留，被取消任务以“恢复随访”替代）
  const wrong = doctorAddOrder(state, 'p1', doctor, {
    content: '立即停用阿司匹林，改布洛芬止痛',
    effectiveAt: hoursAgo(now, 3),
  }, hoursAgo(now, 3), { commandId: 'seed-p1-order-wrong' });
  pharmacistAdvice(state, 'p1', pharmacist, {
    interaction: '华法林 + 布洛芬(NSAID)',
    advice: '该医嘱会显著增加胃肠出血风险，建议医生复核。药师无权修改医嘱，已提示主管医生。',
    severity: 'critical',
  }, hoursAgo(now, 2.8), { commandId: 'seed-p1-adv-wrong' });
  withdrawOrder(state, 'p1', wrong.orderId, doctor,
    '医嘱误录：阿司匹林不可停用，布洛芬与华法林存在出血相互作用，撤回并恢复原随访计划',
    hoursAgo(now, 1), { commandId: 'seed-p1-withdraw' });
  // 已产生 1 次超时提醒
  tickSla(state, hoursAgo(now, 0.5));

  // ===== P2：中风险已处置 → 高风险升级 → 转诊待确认 → 患者再次恶化上报 =====
  generateFollowupPlan(state, 'p2', daysAgo(now, 6));
  const med = submitReport(state, 'p2', { id: 'u_p2', role: 'patient' }, {
    channel: 'mini_app',
    symptoms: ['发热', '伤口红肿渗液'],
    temperature: 38.6, adherence: 'full',
    imageIds: ['img_p2_wound_1.jpg'], imagesReadable: true,
    note: '伤口有点发烫',
  }, hoursAgo(now, 20));
  for (const q of med.queued) {
    if (q.reason.includes('中风险')) {
      resolveManualQueue(state, 'p2', q.taskId, nurse,
        '电话指导体温监测与伤口护理，嘱超过38.5℃返院', hoursAgo(now, 18),
        { commandId: `seed-p2-queue-${q.taskId}` });
    }
  }
  // 高风险：伤口大量渗血 → 升级 → 护士申请转诊（待医生确认）
  const bleed = submitReport(state, 'p2', { id: 'u_p2', role: 'patient' }, {
    channel: 'mini_app',
    symptoms: ['伤口大量渗血'],
    adherence: 'full', imageIds: ['img_p2_bleed.jpg'], imagesReadable: true,
    note: '敷料半小时浸透',
  }, hoursAgo(now, 8));
  nurseScreen(state, 'p2', bleed.escalationTaskId!, nurse, {
    kind: 'referral_request',
    reason: '术后伤口活动性渗血，敷料30分钟浸透，需外科评估止血',
    targetDept: '普外科急诊',
  }, hoursAgo(now, 7), { commandId: 'seed-p2-referral' });
  // 转诊尚未确认，患者换短信入口再次上报恶化（低血压）→ 挂接到转诊单，不重复转诊
  submitReport(state, 'p2', { id: 'u_p2', role: 'patient' }, {
    channel: 'sms',
    symptoms: ['头晕乏力'],
    systolic: 86, diastolic: 52,
    adherence: 'full', imageIds: [], imagesReadable: true,
    note: '站起来眼前发黑',
  }, hoursAgo(now, 2), { commandId: 'seed-p2-deteriorate' });

  // ===== P3：授权过期 + 图片无法读取 + 跨入口重复上报 =====
  generateFollowupPlan(state, 'p3', daysAgo(now, 4));
  submitReport(state, 'p3', { id: 'u_p3', role: 'patient' }, {
    channel: 'mini_app',
    symptoms: ['发热', '颈部胀痛'],
    temperature: 37.9, adherence: 'partial',
    imageIds: ['img_p3_neck_bad.jpg'], imagesReadable: false, // 图片损坏
    note: '脖子肿，照片一直传不清晰',
  }, hoursAgo(now, 6), { commandId: 'seed-p3-r1' });
  // 1 小时后从短信入口重复上报同样症状体征 → 判重
  submitReport(state, 'p3', { id: 'u_p3', role: 'patient' }, {
    channel: 'sms',
    symptoms: ['颈部胀痛', '发热'],
    temperature: 37.9, adherence: 'partial',
    imageIds: [], imagesReadable: true,
  }, hoursAgo(now, 5), { commandId: 'seed-p3-r2-dup' });

  // 截至当前的 SLA 扫描：P1 升级任务第 2 次提醒、P2 转诊待确认升级任务第 1 次提醒
  tickSla(state, nowIso);

  void nowIso;
  return state;
}
