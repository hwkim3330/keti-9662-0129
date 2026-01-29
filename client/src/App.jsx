import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom'
import { CaptureProvider } from './contexts/CaptureContext'
import { DeviceProvider } from './contexts/DeviceContext'
import Dashboard from './pages/Dashboard'
import Settings from './pages/Settings'
import PTP from './pages/PTP'
import TAS from './pages/TAS'
import TASDashboard from './pages/TASDashboard'
import CBS from './pages/CBS'
import CBSDashboard from './pages/CBSDashboard'
import Ports from './pages/Ports'
import Capture from './pages/Capture'
import Tools from './pages/Tools'
import Traffic from './pages/Traffic'

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header" style={{ padding: '24px 20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <img src="/keti.png" alt="KETI" style={{ height: '44px', marginBottom: '12px', filter: 'brightness(0) invert(1)', opacity: 0.95 }} />
        <div style={{ fontSize: '0.9rem', fontWeight: '600', color: 'rgba(255,255,255,0.7)', letterSpacing: '0.02em' }}>TSN Switch Manager</div>
      </div>

      <nav>
        <div className="nav-section">
          <div className="nav-section-title">Dashboards</div>
          <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>PTP Dashboard</span>
          </NavLink>
          <NavLink to="/tas-dashboard" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span>TAS Dashboard</span>
          </NavLink>
          <NavLink to="/cbs-dashboard" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <span>CBS Dashboard</span>
          </NavLink>
        </div>

        <div className="nav-section">
          <div className="nav-section-title">Configuration</div>
          <NavLink to="/ptp" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>PTP (802.1AS)</span>
          </NavLink>
          <NavLink to="/tas" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span>TAS (802.1Qbv)</span>
          </NavLink>
          <NavLink to="/cbs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>CBS (802.1Qav)</span>
          </NavLink>
        </div>

        <div className="nav-section">
          <div className="nav-section-title">Tools</div>
          <NavLink to="/ports" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            <span>Port Status</span>
          </NavLink>
          <NavLink to="/capture" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <span>Packet Capture</span>
          </NavLink>
          <NavLink to="/traffic" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>Traffic Generator</span>
          </NavLink>
        </div>

        <div className="nav-section">
          <div className="nav-section-title">System</div>
          <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <svg className="nav-item-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>Settings</span>
          </NavLink>
        </div>
      </nav>
    </aside>
  )
}

function App() {
  return (
    <DeviceProvider>
    <CaptureProvider>
    <Router>
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/ports" element={<Ports />} />
            <Route path="/capture" element={<Capture />} />
            <Route path="/traffic" element={<Traffic />} />
            <Route path="/ptp" element={<PTP />} />
            <Route path="/tas" element={<TAS />} />
            <Route path="/tas-dashboard" element={<TASDashboard />} />
            <Route path="/cbs" element={<CBS />} />
            <Route path="/cbs-dashboard" element={<CBSDashboard />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </Router>
    </CaptureProvider>
    </DeviceProvider>
  )
}

export default App
