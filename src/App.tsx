import React, { useEffect } from 'react';
import { useStore, ROLE_LABEL } from './store';
import Login from './views/Login';
import PatientView from './views/PatientView';
import NurseView from './views/NurseView';
import DoctorView from './views/DoctorView';
import PharmacistView from './views/PharmacistView';
import { Toasts } from './components/common';
import { fmt } from './rules';

const App: React.FC = () => {
  const store = useStore();
  const user = store.currentUser;

  // 每分钟自动执行一次 SLA 扫描（系统持续提醒能力）
  useEffect(() => {
    const timer = setInterval(() => {
      if (useStore.getState().currentUser) useStore.getState().doTickSla();
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!user) return (<><Login /><Toasts /></>);

  return (
    <>
      <header className="app-header">
        <div className="logo">
          出院后分级随访与高风险升级平台
          <small>事件溯源 · 分级授权脱敏 · 幂等/并发安全</small>
        </div>
        <div className="header-spacer" />
        <span className="header-chip">
          🕒 模拟时钟 {fmt(store.now().toISOString())}
          <button title="快进 1 小时" onClick={() => store.advanceClock(60)}>+1h</button>
          <button title="快进 3 小时" onClick={() => store.advanceClock(180)}>+3h</button>
          <button title="时间回到真实当前" onClick={() => store.setClockOffset(0)}>复位</button>
        </span>
        <span
          className={`header-chip ${store.state.notifyChannelDown ? 'danger' : ''}`}
          title="模拟异步通知通道故障：开启后新通知失败进入 outbox，并把事项转人工队列"
        >
          通知通道：{store.state.notifyChannelDown ? '故障中' : '正常'}
          <button onClick={() => store.setChannelDown(!store.state.notifyChannelDown)}>
            {store.state.notifyChannelDown ? '恢复通道' : '模拟故障'}
          </button>
        </span>
        <span className="header-chip">
          <button title="立即执行一次超时扫描" onClick={() => {
            const n = store.doTickSla();
            if (n === 0) store.pushToast('ok', 'SLA 扫描完成：暂无超时未闭环任务');
          }}>SLA 扫描</button>
          <button title="重置全部演示数据" onClick={() => { if (confirm('确定重置为初始演示数据？')) store.resetDemo(); }}>重置数据</button>
        </span>
        <span className="header-chip">
          {user.name} · {ROLE_LABEL[user.role]}
        </span>
        <button className="link-btn" onClick={store.logout}>退出</button>
      </header>

      {user.role === 'patient' && (
        <div style={{ maxWidth: 920, margin: '0 auto', padding: '18px 16px 60px' }}>
          <PatientView />
        </div>
      )}
      {user.role === 'nurse' && <NurseView />}
      {user.role === 'doctor' && <DoctorView />}
      {user.role === 'pharmacist' && <PharmacistView />}
      <Toasts />
    </>
  );
};

export default App;
