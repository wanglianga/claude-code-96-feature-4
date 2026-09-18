import { useStore } from './store'
import Login from './components/Login'
import Header from './components/Header'
import NurseView from './views/NurseView'
import OrTab from './views/OrTab'
import CashierView from './views/CashierView'
import FamilyView from './views/FamilyView'

export default function App() {
  const user = useStore((s) => s.user)
  if (!user) return <Login />
  return (
    <div className="app">
      <Header />
      <main className="main">
        {user.role === 'nurse' && <NurseView />}
        {user.role === 'anesthetist' && (
          <>
            <div className="role-banner">麻醉医生工作台 — 可见手术区患者，可登记血压异常与麻醉方式改变</div>
            <OrTab role="anesthetist" />
          </>
        )}
        {user.role === 'cashier' && <CashierView />}
        {user.role === 'family' && user.patientId && <FamilyView patientId={user.patientId} />}
      </main>
    </div>
  )
}
