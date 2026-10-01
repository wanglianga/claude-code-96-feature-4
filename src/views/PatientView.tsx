import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Card, PatientBanner, ReportCard, TaskBadge, Badge, isOverdue } from '../components/common';
import Timeline from '../components/Timeline';
import { fmt, LEVEL_LABEL } from '../rules';
import type { Channel } from '../types';

const SYMPTOMS: { label: string; tone: 'high' | 'medium' | '' }[] = [
  { label: '呼吸困难', tone: 'high' }, { label: '胸痛胸闷', tone: 'high' },
  { label: '意识模糊', tone: 'high' }, { label: '伤口大量渗血', tone: 'high' },
  { label: '呕血黑便', tone: 'high' }, { label: '持续高热', tone: 'high' },
  { label: '剧烈腹痛', tone: 'high' }, { label: '单侧肢体无力', tone: 'high' },
  { label: '发热', tone: 'medium' }, { label: '伤口红肿渗液', tone: 'medium' },
  { label: '呕吐', tone: 'medium' }, { label: '明显疼痛加重', tone: 'medium' },
  { label: '皮疹瘙痒', tone: 'medium' }, { label: '心慌心悸', tone: 'medium' },
  { label: '头晕乏力', tone: 'medium' }, { label: '颈部胀痛', tone: '' },
];

const PatientView: React.FC = () => {
  const store = useStore();
  const user = store.currentUser!;
  const pid = user.patientId!;
  const now = store.now();
  const agg = store.aggregate(pid);

  const [channel, setChannel] = useState<Channel>('mini_app');
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [temp, setTemp] = useState('');
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [adherence, setAdherence] = useState<'full' | 'partial' | 'none' | 'unknown'>('full');
  const [hasImage, setHasImage] = useState(false);
  const [imageReadable, setImageReadable] = useState(true);
  const [note, setNote] = useState('');
  const [declineReason, setDeclineReason] = useState('');

  const consentExpired = +now > +new Date(agg.patient.consent.validUntil);

  const toggleSym = (s: string) =>
    setSymptoms((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const submit = () => {
    const r = store.doSubmitReport(pid, {
      channel,
      symptoms,
      temperature: temp ? Number(temp) : undefined,
      systolic: systolic ? Number(systolic) : undefined,
      diastolic: diastolic ? Number(diastolic) : undefined,
      adherence,
      imageIds: hasImage ? [`img_${Date.now().toString(36)}.jpg`] : [],
      imagesReadable: hasImage ? imageReadable : true,
      note: note.trim() || undefined,
    });
    if (r) {
      setSymptoms([]); setTemp(''); setSystolic(''); setDiastolic(''); setNote(''); setHasImage(false);
    }
  };

  const escalation = agg.tasks.find((t) => t.type === 'escalation' && t.status !== 'cancelled');
  const referral = agg.referrals[agg.referrals.length - 1];

  const quickScenarios = useMemo(() => ([
    { name: '① 高风险：胸痛+呼吸困难', apply: () => { setChannel('mini_app'); setSymptoms(['呼吸困难', '胸痛胸闷']); setTemp('37.6'); setSystolic('150'); setDiastolic('96'); setAdherence('partial'); setNote('活动后气促明显'); } },
    { name: '② 跨入口重复上报（先小程序后短信）', apply: () => { setSymptoms(['发热', '伤口红肿渗液']); setTemp('38.6'); setSystolic(''); setDiastolic(''); } },
    { name: '③ 图片无法读取', apply: () => { setSymptoms(['伤口红肿渗液']); setHasImage(true); setImageReadable(false); setNote('伤口照片'); } },
    { name: '④ 转诊待确认期间再次恶化（低血压）', apply: () => { setChannel('sms'); setSymptoms(['头晕乏力']); setTemp(''); setSystolic('86'); setDiastolic('52'); } },
  ]), []);

  return (
    <>
      <Card title="受限入口 · 症状与体征上报">
        {consentExpired && (
          <div className="demo-banner danger">您的随访数据授权已于 {fmt(agg.patient.consent.validUntil)} 过期：上报仍会接收，但系统将暂停自动处理并转入人工队列。</div>
        )}
        {agg.patient.consent.declinedContact && (
          <div className="demo-banner warn">您已选择拒绝主动联系，后续随访事项将通过人工队列核实。</div>
        )}
        <div className="section-sub">
          本入口仅允许提交症状、体温/血压、用药依从性与图片；每条上报带唯一命令令牌，重复点击或多入口重发不会产生重复任务。
        </div>
        <div className="field">
          <label>上报入口（可切换以模拟“不同入口重复上报”）</label>
          <div className="chip-group">
            {(['mini_app', 'sms', 'hotline'] as Channel[]).map((c) => (
              <span key={c} className={`chip ${channel === c ? 'on' : ''}`} onClick={() => setChannel(c)}>
                {c === 'mini_app' ? '小程序' : c === 'sms' ? '短信' : '热线（护士代录）'}
              </span>
            ))}
          </div>
          {channel === 'hotline' && <div className="hint">热线入口由护士代录，患者账号从该入口提交将被服务端拒绝（可登录护士账号验证）。</div>}
        </div>

        <div className="field">
          <label>症状（多选；红色为高风险、黄色为中风险）</label>
          <div className="chip-group">
            {SYMPTOMS.map((s) => (
              <span
                key={s.label}
                className={`chip ${symptoms.includes(s.label) ? `on ${s.tone}` : ''}`}
                onClick={() => toggleSym(s.label)}
              >
                {s.label}
              </span>
            ))}
          </div>
        </div>

        <div className="grid-3">
          <div className="field">
            <label>体温（℃）</label>
            <input type="number" step="0.1" value={temp} onChange={(e) => setTemp(e.target.value)} placeholder="如 38.6" />
          </div>
          <div className="field">
            <label>收缩压（mmHg）</label>
            <input type="number" value={systolic} onChange={(e) => setSystolic(e.target.value)} placeholder="如 120" />
          </div>
          <div className="field">
            <label>舒张压（mmHg）</label>
            <input type="number" value={diastolic} onChange={(e) => setDiastolic(e.target.value)} placeholder="如 80" />
          </div>
        </div>

        <div className="field">
          <label>用药依从性</label>
          <div className="chip-group">
            {([
              ['full', '完全依从'], ['partial', '部分漏服'], ['none', '完全未服药'], ['unknown', '未报告'],
            ] as const).map(([v, l]) => (
              <span key={v} className={`chip ${adherence === v ? 'on' : ''}`} onClick={() => setAdherence(v)}>{l}</span>
            ))}
          </div>
        </div>

        <div className="field">
          <label>伤口/症状图片</label>
          <div className="checkline">
            <input type="checkbox" checked={hasImage} onChange={(e) => setHasImage(e.target.checked)} id="hasimg" />
            <label htmlFor="hasimg" style={{ margin: 0 }}>上传图片（模拟）</label>
          </div>
          {hasImage && (
            <div className="checkline">
              <input type="checkbox" checked={!imageReadable} onChange={(e) => setImageReadable(!e.target.checked)} id="badimg" />
              <label htmlFor="badimg" style={{ margin: 0 }}>图片损坏/无法读取（系统将转人工队列）</label>
            </div>
          )}
        </div>

        <div className="field">
          <label>补充说明</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
        </div>

        <div className="btn-row">
          <button className="btn primary" onClick={submit}>提交上报（幂等令牌自动生成）</button>
        </div>
        <div className="divider" />
        <div className="small muted">一键填充验证场景：</div>
        <div className="btn-row">
          {quickScenarios.map((q) => (
            <button key={q.name} className="btn small" onClick={q.apply}>{q.name}</button>
          ))}
        </div>
      </Card>

      <Card title="我的随访与处置状态">
        {escalation && (
          <div className={`report-box ${escalation.status === 'done' ? '' : 'high'}`}>
            <div className="rtop">
              <b>{escalation.title}</b>
              <TaskBadge status={escalation.status} />
              {isOverdue(escalation, now) && <Badge tone="red">已超时</Badge>}
            </div>
            {referral && (
              <div className="ref-card">
                <div className="rtop">
                  <b>转诊单 → {referral.targetDept}</b>
                  <Badge tone={referral.status === 'confirmed' ? 'green' : referral.status === 'rejected' ? 'gray' : 'amber'}>
                    {{ requested: '待医院确认', confirmed: '已确认', rejected: '已驳回', cancelled: '已取消' }[referral.status]}
                  </Badge>
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>原因：{referral.reason}</div>
                {referral.pendingNotes.length > 0 && (
                  <div className="pending-note">
                    转诊确认期间您的 {referral.pendingNotes.length} 次恶化补充已挂接在本转诊单上（不会重复转诊）：
                    {referral.pendingNotes.map((n, i) => <div key={i}>· {fmt(n.at)} {n.text}</div>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <h4>常规随访计划（高风险期间自动冻结）</h4>
        {agg.tasks.filter((t) => t.type === 'routine_followup').map((t) => (
          <div key={t.id} className="checkline" style={{ justifyContent: 'space-between' }}>
            <span>{t.title} · 应完成 {fmt(t.dueAt)}</span>
            <span><TaskBadge status={t.status} /></span>
          </div>
        ))}
        <div className="divider" />
        <h4>拒绝联系</h4>
        <div className="field">
          <input type="text" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="如：暂不方便接听电话，请短信留言" />
        </div>
        <button className="btn" disabled={agg.patient.consent.declinedContact} onClick={() => { if (declineReason.trim()) { store.doDeclineContact(pid, declineReason.trim()); setDeclineReason(''); } }}>
          {agg.patient.consent.declinedContact ? '已记录拒绝联系' : '登记“拒绝主动联系”（转人工队列）'}
        </button>
      </Card>

      <Card title="我的上报记录">
        {agg.reports.slice().reverse().map((r) => <ReportCard key={r.id} report={r} showSensitive />)}
      </Card>

      <PatientBanner agg={agg} role="patient" self />
      <Timeline state={store.state} patientId={pid} />
    </>
  );
};

export default PatientView;
