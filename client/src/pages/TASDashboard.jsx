import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

// Interface configuration
const TX_INTERFACE = 'enxc84d44263ba6'
const RX_INTERFACE = 'enx00e04c6812d1'
const DST_MAC = '00:e0:4c:68:12:d1'
const API_BASE = 'http://localhost:3000'

// Color palette
const colors = {
  bg: '#f8fafc',
  card: '#ffffff',
  border: '#e2e8f0',
  text: '#1e293b',
  textMuted: '#64748b',
  textLight: '#94a3b8',
  accent: '#475569',
  success: '#059669',
  warning: '#d97706',
  error: '#dc2626',
}

const tcColors = ['#94a3b8', '#64748b', '#475569', '#334155', '#1e3a5f', '#1e40af', '#3730a3', '#4c1d95']

// Packet Timeline Component
const PacketTimeline = ({ packets, maxTime, height = 120, label, iface, color }) => {
  const width = 800
  const pad = { top: 20, right: 16, bottom: 24, left: 48 }
  const chartW = width - pad.left - pad.right
  const chartH = height - pad.top - pad.bottom
  const rowH = chartH / 8

  const xScale = (t) => pad.left + Math.min(t / maxTime, 1) * chartW

  return (
    <div style={{ marginBottom: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{
            fontSize: '0.7rem', fontWeight: '600', color: color,
            padding: '2px 8px', background: `${color}15`, borderRadius: '3px'
          }}>{label}</span>
          <span style={{ fontSize: '0.65rem', color: colors.textMuted, fontFamily: 'monospace' }}>{iface}</span>
        </div>
        <span style={{ fontSize: '0.65rem', color: colors.textMuted, fontFamily: 'monospace' }}>{packets.length} pkts</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px' }}>
        {[0,1,2,3,4,5,6,7].map(tc => (
          <g key={tc}>
            <rect x={pad.left} y={pad.top + tc * rowH} width={chartW} height={rowH}
              fill={tc % 2 === 0 ? '#fafafa' : '#fff'} />
            <text x={pad.left - 4} y={pad.top + tc * rowH + rowH/2 + 3}
              textAnchor="end" fontSize="8" fill={tcColors[tc]} fontWeight="500">TC{tc}</text>
          </g>
        ))}

        {[0, 1, 2, 3, 4, 5].map(s => {
          const t = s * 1000
          if (t > maxTime) return null
          return (
            <g key={s}>
              <line x1={xScale(t)} y1={pad.top} x2={xScale(t)} y2={height - pad.bottom}
                stroke={colors.border} strokeDasharray="2,2" strokeWidth="0.5" />
              <text x={xScale(t)} y={height - 6} textAnchor="middle" fontSize="7" fill={colors.textLight}>{s}s</text>
            </g>
          )
        })}

        {packets.map((pkt, i) => {
          const x = xScale(pkt.time)
          const y = pad.top + pkt.tc * rowH + rowH / 2
          if (x < pad.left || x > width - pad.right) return null
          return <line key={i} x1={x} y1={y - 2} x2={x} y2={y + 2} stroke={tcColors[pkt.tc]} strokeWidth="1" opacity="0.7" />
        })}

        <rect x={pad.left} y={pad.top} width={chartW} height={chartH} fill="none" stroke={colors.border} strokeWidth="1" />
      </svg>
    </div>
  )
}

// GCL Heatmap
const GCLHeatmap = ({ gcl, title, active }) => {
  const slots = gcl.length > 0 ? gcl : Array(8).fill({ gates: 255, time: 125000000 })

  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontSize: '0.7rem', fontWeight: '600', color: colors.text }}>{title}</span>
        <span style={{
          fontSize: '0.55rem', padding: '1px 4px', borderRadius: '2px',
          background: active ? '#d1fae5' : colors.bg,
          color: active ? colors.success : colors.textMuted
        }}>{active ? 'ON' : 'OFF'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '24px repeat(8, 1fr)', gap: '1px' }}>
        <div></div>
        {[0,1,2,3,4,5,6,7].map(tc => (
          <div key={tc} style={{ textAlign: 'center', fontSize: '0.5rem', fontWeight: '500', color: tcColors[tc] }}>TC{tc}</div>
        ))}
        {slots.slice(0, 8).map((entry, slot) => (
          <div key={slot} style={{ display: 'contents' }}>
            <div style={{ fontSize: '0.45rem', color: colors.textMuted, display: 'flex', alignItems: 'center' }}>S{slot}</div>
            {[0,1,2,3,4,5,6,7].map(tc => {
              const open = (entry.gates >> tc) & 1
              return (
                <div key={tc} style={{
                  height: '12px', borderRadius: '1px',
                  background: open ? tcColors[tc] : '#f1f5f9',
                  opacity: open ? 0.7 : 1,
                  border: `1px solid ${open ? tcColors[tc] : colors.border}`,
                }}></div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function TASDashboard() {
  const { devices } = useDevices()
  const [status, setStatus] = useState(null)
  const [testing, setTesting] = useState(false)
  const [txPackets, setTxPackets] = useState([])
  const [rxPackets, setRxPackets] = useState([])
  const [stats, setStats] = useState(null)
  const [tasConfig, setTasConfig] = useState({ enabled: false, cycleNs: 0, guardNs: 0, gcl: [] })

  const [selectedTCs, setSelectedTCs] = useState([1, 2, 3, 4, 5, 6, 7])
  const [vlanId, setVlanId] = useState(100)
  const [pps, setPps] = useState(100)
  const [duration, setDuration] = useState(5)
  const [outputPort, setOutputPort] = useState('1')

  const [cycleMs, setCycleMs] = useState(1000)
  const [guardNs, setGuardNs] = useState(256)

  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef(null)
  const startTimeRef = useRef(null)
  const txPacketsRef = useRef([])
  const rxPacketsRef = useRef([])

  const board = devices.find(d => d.device?.includes('ACM'))
  const basePath = `/ietf-interfaces:interfaces/interface[name='${outputPort}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table`

  // Fetch TAS config
  const fetchTAS = async () => {
    if (!board) return
    try {
      const res = await axios.post('/api/fetch', {
        paths: [basePath],
        transport: board.transport || 'serial',
        device: board.device
      }, { timeout: 15000 })

      const yaml = res.data?.result || ''
      const config = { enabled: false, cycleNs: 0, guardNs: 0, gcl: [] }

      if (/gate-enabled:\s*true/.test(yaml)) config.enabled = true
      const cycleMatch = yaml.match(/admin-cycle-time:[\s\S]*?numerator:\s*(\d+)/)
      if (cycleMatch) config.cycleNs = parseInt(cycleMatch[1])
      const guardMatch = yaml.match(/admin-cycle-time-extension:\s*(\d+)/)
      if (guardMatch) config.guardNs = parseInt(guardMatch[1])

      const gclMatch = yaml.match(/admin-control-list:[\s\S]*?gate-control-entry:([\s\S]*?)(?=oper-|$)/)
      if (gclMatch) {
        const entries = [...gclMatch[1].matchAll(/gate-states-value:\s*(\d+)[\s\S]*?time-interval-value:\s*(\d+)/g)]
        config.gcl = entries.map(m => ({ gates: parseInt(m[1]), time: parseInt(m[2]) }))
      }

      setTasConfig(config)
      if (config.cycleNs) setCycleMs(config.cycleNs / 1000000)
      if (config.guardNs) setGuardNs(config.guardNs)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

  useEffect(() => { if (board) fetchTAS() }, [board])

  // WebSocket
  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ws/capture`)
      ws.onopen = () => setWsConnected(true)
      ws.onclose = () => { setWsConnected(false); setTimeout(connect, 3000) }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'c-capture-stats' && startTimeRef.current) {
            const elapsed = Date.now() - startTimeRef.current
            if (msg.data.tc) {
              Object.entries(msg.data.tc).forEach(([tc, data]) => {
                const tcNum = parseInt(tc)
                const prevCount = rxPacketsRef.current.filter(p => p.tc === tcNum).length
                const newCount = (data.count || 0) - prevCount
                for (let i = 0; i < newCount; i++) {
                  rxPacketsRef.current.push({ tc: tcNum, time: elapsed - (newCount - i) * 2 })
                }
              })
              setRxPackets([...rxPacketsRef.current])
            }
          }
          if (msg.type === 'c-capture-stopped' && msg.stats) {
            setStats(msg.stats.analysis || msg.stats.tc)
            setTesting(false)
          }
        } catch {}
      }
      wsRef.current = ws
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  // Apply TAS
  const applyTAS = async () => {
    if (!board) return
    setStatus({ type: 'info', msg: 'Applying TAS...' })
    try {
      const slotTimeNs = Math.round((cycleMs * 1000000) / 8)
      const entries = selectedTCs.map((tc, i) => ({
        index: i,
        'operation-name': 'ieee802-dot1q-sched:set-gate-states',
        'time-interval-value': slotTimeNs,
        'gate-states-value': (1 << tc) | 1
      }))
      for (let i = selectedTCs.length; i < 8; i++) {
        entries.push({
          index: i,
          'operation-name': 'ieee802-dot1q-sched:set-gate-states',
          'time-interval-value': slotTimeNs,
          'gate-states-value': 1
        })
      }

      await axios.post('/api/patch', {
        patches: [
          { path: `${basePath}/gate-enabled`, value: true },
          { path: `${basePath}/admin-gate-states`, value: 255 },
          { path: `${basePath}/admin-control-list/gate-control-entry`, value: entries },
          { path: `${basePath}/admin-cycle-time/numerator`, value: Math.round(cycleMs * 1000000) },
          { path: `${basePath}/admin-cycle-time/denominator`, value: 1 },
          { path: `${basePath}/admin-cycle-time-extension`, value: guardNs },
        ],
        transport: board.transport || 'serial',
        device: board.device
      }, { timeout: 30000 })

      await axios.post('/api/patch', {
        patches: [{ path: `${basePath}/config-change`, value: true }],
        transport: board.transport || 'serial',
        device: board.device
      }, { timeout: 10000 })

      setStatus({ type: 'success', msg: 'TAS applied to port ' + outputPort })
      setTimeout(() => { fetchTAS(); setStatus(null) }, 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

  // Disable TAS
  const disableTAS = async () => {
    if (!board) return
    setStatus({ type: 'info', msg: 'Disabling TAS...' })
    try {
      await axios.post('/api/patch', {
        patches: [{ path: `${basePath}/gate-enabled`, value: false }],
        transport: board.transport || 'serial',
        device: board.device
      }, { timeout: 15000 })
      setStatus({ type: 'success', msg: 'TAS disabled' })
      setTimeout(() => { fetchTAS(); setStatus(null) }, 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

  // Simulate TX packets
  const simulateTxPackets = () => {
    const intervalMs = 1000 / pps
    const totalPackets = pps * duration * selectedTCs.length
    const packets = []
    let time = 0
    for (let i = 0; i < totalPackets; i++) {
      const tc = selectedTCs[i % selectedTCs.length]
      packets.push({ tc, time })
      time += intervalMs
    }
    return packets
  }

  // Run test
  const runTest = async () => {
    if (selectedTCs.length === 0 || testing) return
    txPacketsRef.current = []
    rxPacketsRef.current = []
    setTxPackets([])
    setRxPackets([])
    setStats(null)
    startTimeRef.current = Date.now()
    setTesting(true)
    setStatus({ type: 'info', msg: 'Starting test...' })

    try {
      await axios.post('/api/capture/stop-c').catch(() => {})
      await new Promise(r => setTimeout(r, 300))

      await axios.post('/api/capture/start-c', { interface: RX_INTERFACE, duration: duration + 3, vlanId })
      await new Promise(r => setTimeout(r, 500))

      setStatus({ type: 'info', msg: 'Sending traffic...' })

      const txPkts = simulateTxPackets()
      txPacketsRef.current = txPkts
      setTxPackets(txPkts)

      await axios.post(`${API_BASE}/api/traffic/start-precision`, {
        interface: TX_INTERFACE, dstMac: DST_MAC, vlanId, tcList: selectedTCs,
        packetsPerSecond: pps * selectedTCs.length, duration
      })

      setTimeout(async () => {
        const res = await axios.get('/api/capture/status-c')
        if (res.data?.stats?.tc) {
          setStats(res.data.stats.tc)
        }
        setTesting(false)
        const rxCount = res.data?.stats?.packets || rxPacketsRef.current.length
        const txCount = txPacketsRef.current.length
        setStatus({ type: 'success', msg: `TX: ${txCount}, RX: ${rxCount}` })
        setTimeout(() => setStatus(null), 3000)
      }, (duration + 2) * 1000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.response?.data?.error || err.message })
      setTesting(false)
    }
  }

  const maxTime = (duration + 1) * 1000
  const currentCycleMs = tasConfig.cycleNs ? tasConfig.cycleNs / 1000000 : 1000

  return (
    <div style={{ padding: '16px', background: colors.bg, minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <h1 style={{ fontSize: '1.1rem', fontWeight: '600', margin: 0, color: colors.text }}>TAS Configuration</h1>
          <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>Time-Aware Shaper - IEEE 802.1Qbv</div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {status && (
            <span style={{
              padding: '3px 8px', borderRadius: '3px', fontSize: '0.7rem',
              background: status.type === 'success' ? '#d1fae5' : status.type === 'error' ? '#fecaca' : '#e2e8f0',
              color: status.type === 'success' ? colors.success : status.type === 'error' ? colors.error : colors.textMuted
            }}>{status.msg}</span>
          )}
          <span style={{
            padding: '3px 6px', borderRadius: '3px', fontSize: '0.65rem',
            background: tasConfig.enabled ? '#d1fae5' : '#fecaca',
            color: tasConfig.enabled ? colors.success : colors.error
          }}>{tasConfig.enabled ? 'TAS ON' : 'TAS OFF'}</span>
        </div>
      </div>

      {/* Network Path */}
      <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '12px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', fontSize: '0.7rem' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '6px 10px', background: '#dbeafe', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.65rem' }}>{TX_INTERFACE}</div>
            <div style={{ color: colors.textMuted, fontSize: '0.6rem', marginTop: '2px' }}>TX</div>
          </div>
          <div style={{ color: colors.textLight }}>→</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '6px 10px', border: `2px solid ${colors.accent}`, borderRadius: '3px' }}>
              <div style={{ fontWeight: '600', fontSize: '0.75rem' }}>LAN9662</div>
            </div>
          </div>
          <div style={{ color: colors.textLight }}>→</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '6px 10px', background: '#fef3c7', borderRadius: '3px' }}>
              <div style={{ fontFamily: 'monospace', fontSize: '0.65rem' }}>Port {outputPort}</div>
              <div style={{ fontSize: '0.55rem', color: colors.warning }}>TAS</div>
            </div>
          </div>
          <div style={{ color: colors.textLight }}>→</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '6px 10px', background: '#dcfce7', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.65rem' }}>{RX_INTERFACE}</div>
            <div style={{ color: colors.textMuted, fontSize: '0.6rem', marginTop: '2px' }}>RX</div>
          </div>
        </div>
      </div>

      {/* Status Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px', marginBottom: '12px' }}>
        {[
          { label: 'Cycle', value: `${currentCycleMs.toFixed(0)} ms` },
          { label: 'Guard', value: `${tasConfig.guardNs} ns` },
          { label: 'Slots', value: tasConfig.gcl?.length || 8 },
          { label: 'Slot Time', value: `${(currentCycleMs / (tasConfig.gcl?.length || 8)).toFixed(1)} ms` },
          { label: 'Status', value: tasConfig.enabled ? 'ON' : 'OFF', color: tasConfig.enabled ? colors.success : colors.textMuted },
        ].map((item, i) => (
          <div key={i} style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '8px' }}>
            <div style={{ fontSize: '0.55rem', color: colors.textMuted, marginBottom: '2px' }}>{item.label}</div>
            <div style={{ fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: '600', color: item.color || colors.text }}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Config Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
        {/* Test Config */}
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '12px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: '600', marginBottom: '8px', color: colors.text }}>Test Configuration</div>

          <div style={{ marginBottom: '8px' }}>
            <div style={{ fontSize: '0.65rem', color: colors.textMuted, marginBottom: '4px' }}>Traffic Classes</div>
            <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
              {[0,1,2,3,4,5,6,7].map(tc => (
                <button key={tc} onClick={() => !testing && setSelectedTCs(p => p.includes(tc) ? p.filter(t => t !== tc) : [...p, tc].sort())}
                  disabled={testing}
                  style={{
                    padding: '3px 8px', borderRadius: '2px', fontSize: '0.7rem', fontWeight: '500',
                    border: `1px solid ${selectedTCs.includes(tc) ? tcColors[tc] : colors.border}`,
                    background: selectedTCs.includes(tc) ? `${tcColors[tc]}15` : colors.card,
                    color: selectedTCs.includes(tc) ? tcColors[tc] : colors.textLight,
                    cursor: testing ? 'not-allowed' : 'pointer'
                  }}>TC{tc}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '8px' }}>
            {[['VLAN', vlanId, setVlanId], ['PPS/TC', pps, setPps], ['Duration', duration, setDuration], ['Port', outputPort, setOutputPort]].map(([label, val, setter]) => (
              <div key={label}>
                <div style={{ fontSize: '0.6rem', color: colors.textMuted, marginBottom: '2px' }}>{label}</div>
                <input type={label === 'Port' ? 'text' : 'number'} value={val}
                  onChange={e => setter(label === 'Port' ? e.target.value : +e.target.value)}
                  disabled={testing}
                  style={{ width: '100%', padding: '3px 4px', borderRadius: '2px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '0.7rem' }} />
              </div>
            ))}
          </div>

          <button onClick={runTest} disabled={testing || selectedTCs.length === 0 || !wsConnected}
            style={{
              width: '100%', padding: '6px', borderRadius: '3px', fontWeight: '600', fontSize: '0.75rem',
              background: testing ? colors.textLight : colors.accent, color: '#fff', border: 'none',
              cursor: testing || selectedTCs.length === 0 ? 'not-allowed' : 'pointer'
            }}>
            {testing ? 'Testing...' : 'Run Test'}
          </button>
        </div>

        {/* TAS Config */}
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '12px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: '600', marginBottom: '8px', color: colors.text }}>TAS Parameters</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px', marginBottom: '8px' }}>
            <div>
              <div style={{ fontSize: '0.6rem', color: colors.textMuted, marginBottom: '2px' }}>Cycle (ms)</div>
              <input type="number" value={cycleMs} onChange={e => setCycleMs(+e.target.value)}
                style={{ width: '100%', padding: '3px 4px', borderRadius: '2px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '0.7rem' }} />
            </div>
            <div>
              <div style={{ fontSize: '0.6rem', color: colors.textMuted, marginBottom: '2px' }}>Guard (ns)</div>
              <input type="number" value={guardNs} onChange={e => setGuardNs(+e.target.value)}
                style={{ width: '100%', padding: '3px 4px', borderRadius: '2px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '0.7rem' }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={applyTAS} disabled={!board || testing}
              style={{ flex: 1, padding: '5px', background: colors.accent, color: '#fff', border: 'none', borderRadius: '3px', fontSize: '0.7rem', fontWeight: '500', cursor: 'pointer' }}>
              Apply TAS
            </button>
            <button onClick={disableTAS} disabled={!board || testing}
              style={{ flex: 1, padding: '5px', background: colors.textLight, color: '#fff', border: 'none', borderRadius: '3px', fontSize: '0.7rem', fontWeight: '500', cursor: 'pointer' }}>
              Disable
            </button>
            <button onClick={fetchTAS} disabled={!board}
              style={{ flex: 1, padding: '5px', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: '3px', fontSize: '0.7rem', fontWeight: '500', cursor: 'pointer' }}>
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Packet Timelines - TX and RX in separate cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '12px' }}>
          <PacketTimeline packets={txPackets} maxTime={maxTime} label="TX" iface={TX_INTERFACE} color="#2563eb" />
        </div>
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '12px' }}>
          <PacketTimeline packets={rxPackets} maxTime={maxTime} label="RX" iface={RX_INTERFACE} color="#16a34a" />
        </div>
      </div>

      {/* GCL Heatmaps */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
        <GCLHeatmap gcl={tasConfig.gcl} title="Current GCL" active={tasConfig.enabled} />
        <GCLHeatmap gcl={[]} title="Estimated GCL" active={false} />
      </div>

      {/* Results Table */}
      {stats && (
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '12px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: '600', marginBottom: '8px', color: colors.text }}>Results</div>
          <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: colors.bg }}>
                <th style={{ padding: '4px', textAlign: 'left' }}>TC</th>
                <th style={{ padding: '4px', textAlign: 'right' }}>Packets</th>
                <th style={{ padding: '4px', textAlign: 'right' }}>Avg Interval</th>
                <th style={{ padding: '4px', textAlign: 'right' }}>Std Dev</th>
                <th style={{ padding: '4px', textAlign: 'right' }}>Bandwidth</th>
                <th style={{ padding: '4px', textAlign: 'center' }}>Gating</th>
              </tr>
            </thead>
            <tbody>
              {selectedTCs.map(tc => {
                const data = stats[tc]
                if (!data) return null
                const avgMs = data.avg_ms ?? (data.avg_us / 1000)
                const gated = avgMs > cycleMs * 0.8
                return (
                  <tr key={tc} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td style={{ padding: '4px', fontWeight: '500', color: tcColors[tc] }}>TC{tc}</td>
                    <td style={{ padding: '4px', textAlign: 'right', fontFamily: 'monospace' }}>{data.count}</td>
                    <td style={{ padding: '4px', textAlign: 'right', fontFamily: 'monospace' }}>{avgMs?.toFixed(2)} ms</td>
                    <td style={{ padding: '4px', textAlign: 'right', fontFamily: 'monospace' }}>{(data.stddev_ms || 0).toFixed(2)} ms</td>
                    <td style={{ padding: '4px', textAlign: 'right', fontFamily: 'monospace' }}>{(data.kbps || 0).toFixed(1)} kbps</td>
                    <td style={{ padding: '4px', textAlign: 'center' }}>
                      <span style={{
                        padding: '1px 4px', borderRadius: '2px', fontSize: '0.6rem',
                        background: gated ? '#d1fae5' : '#fef3c7',
                        color: gated ? colors.success : colors.warning
                      }}>{gated ? 'GATED' : 'FREE'}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default TASDashboard
