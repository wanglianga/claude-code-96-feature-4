import { useState } from 'react'
import BoardTab from './BoardTab'
import AssessTab from './AssessTab'
import OrTab from './OrTab'
import PacuTab from './PacuTab'
import DischargeTab from './DischargeTab'
import StatsTab from './StatsTab'

const TABS = [
  { key: 'board', label: '候诊区看板' },
  { key: 'assess', label: '术前评估区' },
  { key: 'or', label: '手术区' },
  { key: 'pacu', label: '复苏室' },
  { key: 'discharge', label: '离院管理' },
  { key: 'stats', label: '周转统计' },
] as const

type TabKey = (typeof TABS)[number]['key']

export default function NurseView() {
  const [tab, setTab] = useState<TabKey>('board')
  return (
    <div>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'tab active' : 'tab'} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'board' && <BoardTab />}
      {tab === 'assess' && <AssessTab />}
      {tab === 'or' && <OrTab role="nurse" />}
      {tab === 'pacu' && <PacuTab />}
      {tab === 'discharge' && <DischargeTab />}
      {tab === 'stats' && <StatsTab />}
    </div>
  )
}
