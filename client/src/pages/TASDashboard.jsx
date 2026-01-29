import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

// Interface configuration
const TX_INTERFACE = 'enxc84d44263ba6'
const RX_INTERFACE = 'enx00e04c6812d1'
const DST_MAC = '00:e0:4c:68:12:d1'
const API_BASE = 'http://localhost:3000'

// Color palette (toned down)
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

// Packet timeline visualization
const PacketTimeline = ({ packets, maxTime, height = 160 }) => {
  const width = 800
  const pad = { top: 16, right: 16, bottom: 28, left: 48 }
  const chartW = width - pad.left - pad.right
  const chartH = height - pad.top - pad.bottom
  const rowH = chartH / 8

  const xScale = (t) => pad.left + Math.min(t / maxTime, 1) * chartW

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', background: colors.card }}>
      {[0,1,2,3,4,5,6,7].map(tc => (
        <g key={tc}>
          <rect x={pad.left} y={pad.top + tc * rowH} width={chartW} height={rowH}
            fill={tc % 2 === 0 ? '#f8fafc' : '#fff'} stroke={colors.border} strokeWidth="0.5" />
          <text x={pad.left - 6} y={pad.top + tc * rowH + rowH/2 + 3}
            textAnchor="end" fontSize="9" fill={tcColors[tc]} fontWeight="500">TC{tc}</text>
        </g>
      ))}
      {[0,1,2,3,4,5].map(s => {
        const t = s * 1000
        if (t > maxTime) return null
        return (
          <g key={s}>
            <line x1={xScale(t)} y1={pad.top} x2={xScale(t)} y2={height - pad.bottom}
              stroke={colors.border} strokeDasharray="2,2" strokeWidth="0.5" />
            <text x={xScale(t)} y={height - 8} textAnchor="middle" fontSize="8" fill={colors.textLight}>{s}s</text>
          </g>
        )
      })}
      {packets.map((pkt, i) => {
        const x = xScale(pkt.time)
        const y = pad.top + pkt.tc * rowH + rowH / 2
        if (x < pad.left || x > width - pad.right) return null
        return <line key={i} x1={x} y1={y - 3} x2={x} y2={y + 3} stroke={tcColors[pkt.tc]} strokeWidth="1" opacity="0.6" />
      })}
      <rect x={pad.left} y={pad.top} width={chartW} height={chartH} fill="none" stroke={colors.border} strokeWidth="1" />
    </svg>
  )
}

// GCL Heatmap (8 slots x 8 TCs)
const GCLHeatmap = ({ gcl, title, active }) => {
  const slots = gcl.length > 0 ? gcl : Array(8).fill({ gates: 255, time: 125000000 })

  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: '600', color: colors.text }}>{title}</span>
        <span style={{
          fontSize: '0.6rem', padding: '2px 6px', borderRadius: '3px',
          background: active ? '#d1fae5' : colors.bg,
          color: active ? colors.success : colors.textMuted
        }}>{active ? 'ACTIVE' : 'INACTIVE'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '32px repeat(8, 1fr)', gap: '1px' }}>
        <div></div>
        {[0,1,2,3,4,5,6,7].map(tc => (
          <div key={tc} style={{ textAlign: 'center', fontSize: '0.55rem', fontWeight: '500', color: tcColors[tc], padding: '2px 0' }}>TC{tc}</div>
        ))}
        {slots.slice(0, 8).map((entry, slot) => (
          <div key={slot} style={{ display: 'contents' }}>
            <div style={{ fontSize: '0.5rem', color: colors.textMuted, display: 'flex', alignItems: 'center' }}>S{slot}</div>
            {[0,1,2,3,4,5,6,7].map(tc => {
              const open = (entry.gates >> tc) & 1
              return (
                <div key={tc} style={{
                  height: '14px', borderRadius: '2px',
                  background: open ? tcColors[tc] : '#f1f5f9',
                  opacity: open ? 0.75 : 1,
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

// GCL Estimation Heatmap with confidence
const GCLEstimationHeatmap = ({ stats, selectedTCs, cycleMs }) => {
  if (!stats) return null

  // Build estimation matrix
  const matrix = Array(8).fill(null).map(() => Array(8).fill(null))

  selectedTCs.forEach(tc => {
    const data = stats[tc]
    if (!data) return
    const avgMs = data.avg_ms ?? (data.avg_us / 1000)
    const stddev = data.stddev_ms || 0
    const count = data.count || 0

    // Estimate slot based on TC (simple mapping)
    const slot = tc % 8
    const confidence = stddev < 5 ? 0.9 : stddev < 10 ? 0.7 : 0.5
    const gated = avgMs > cycleMs * 0.8

    matrix[slot][tc] = { count, avgMs, stddev, confidence, gated }
  })

  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '12px' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: '600', marginBottom: '8px', color: colors.text }}>Estimated GCL</div>
      <div style={{ display: 'grid', gridTemplateColumns: '32px repeat(8, 1fr)', gap: '1px' }}>
        <div></div>
        {[0,1,2,3,4,5,6,7].map(tc => (
          <div key={tc} style={{ textAlign: 'center', fontSize: '0.55rem', fontWeight: '500', color: tcColors[tc], padding: '2px 0' }}>TC{tc}</div>
        ))}
        {matrix.map((row, slot) => (
          <div key={slot} style={{ display: 'contents' }}>
            <div style={{ fontSize: '0.5rem', color: colors.textMuted, display: 'flex', alignItems: 'center' }}>S{slot}</div>
            {row.map((cell, tc) => (
              <div key={tc} style={{
                height: '14px', borderRadius: '2px',
                background: cell ? (cell.gated ? '#d1fae5' : '#fef3c7') : '#f1f5f9',
                opacity: cell ? cell.confidence : 1,
                border: `1px solid ${cell ? (cell.gated ? colors.success : colors.warning) : colors.border}`,
              }} title={cell ? `${cell.count} pkts, ${cell.avgMs?.toFixed(1)}ms ±${cell.stddev?.toFixed(1)}` : ''}></div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop: '6px', fontSize: '0.6rem', color: colors.textMuted }}>
        <span style={{ display: 'inline-block', width: '10px', height: '10px', background: '#d1fae5', borderRadius: '2px', marginRight: '4px' }}></span>Gated
        <span style={{ display: 'inline-block', width: '10px', height: '10px', background: '#fef3c7', borderRadius: '2px', marginLeft: '12px', marginRight: '4px' }}></span>Free
      </div>
    </div>
  )
}

function TASDashboard() {
  const { devices } = useDevices()
  const [status, setStatus] = useState(null)
  const [testing, setTesting] = useState(false)
  const [packets, setPackets] = useState([])
  const [stats, setStats] = useState(null)
  const [tasConfig, setTasConfig] = useState({ enabled: false, cycleNs: 0, guardNs: 0, gcl: [] })

  const [selectedTCs, setSelectedTCs] = useState([1, 2, 3, 4, 5, 6, 7])
  const [vlanId, setVlanId] = useState(100)
  const [pps, setPps] = useState(100)
  const [duration, setDuration] = useState(5)
  const [outputPort, setOutputPort] = useState('1')

  // TAS configuration
  const [cycleMs, setCycleMs] = useState(1000)
  const [guardNs, setGuardNs] = useState(256)

  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef(null)
  const startTimeRef = useRef(null)
  const packetsRef = useRef([])

  const board = devices.find(d => d.device?.includes('ACM'))
  const basePath = `/ietf-interfaces:interfaces/interface[name='${outputPort}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table`

  // Fetch TAS configuration
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
                const prevCount = packetsRef.current.filter(p => p.tc === tcNum).length
                const newCount = (data.count || 0) - prevCount
                for (let i = 0; i < newCount; i++) {
                  packetsRef.current.push({ tc: tcNum, time: elapsed - (newCount - i) * 2 })
                }
              })
              setPackets([...packetsRef.current])
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

  // Apply TAS configuration
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

  // Apply estimation
  const applyEstimation = async () => {
    if (!stats) return
    // Calculate estimated cycle time from average intervals
    let totalMs = 0, count = 0
    selectedTCs.forEach(tc => {
      const data = stats[tc]
      if (data) {
        const avgMs = data.avg_ms ?? (data.avg_us / 1000)
        if (avgMs) { totalMs += avgMs; count++ }
      }
    })
    if (count > 0) {
      const estCycle = totalMs / count
      setCycleMs(estCycle)
    }
    await applyTAS()
  }

  // Run test
  const runTest = async () => {
    if (selectedTCs.length === 0 || testing) return
    packetsRef.current = []
    setPackets([])
    setStats(null)
    startTimeRef.current = Date.now()
    setTesting(true)

    try {
      await axios.post('/api/capture/start-c', { interface: RX_INTERFACE, duration: duration + 2, vlanId })
      await new Promise(r => setTimeout(r, 500))
      await axios.post(`${API_BASE}/api/traffic/start-precision`, {
        interface: TX_INTERFACE, dstMac: DST_MAC, vlanId, tcList: selectedTCs,
        packetsPerSecond: pps * selectedTCs.length, duration
      })
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
      setTesting(false)
    }
  }

  const maxTime = (duration + 1) * 1000
  const currentCycleMs = tasConfig.cycleNs ? tasConfig.cycleNs / 1000000 : 1000

  return (
    <div style={{ padding: '20px', background: colors.bg, minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: '600', margin: 0, color: colors.text }}>TAS Configuration</h1>
          <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginTop: '4px' }}>
            Time-Aware Shaper - IEEE 802.1Qbv
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {status && (
            <span style={{
              padding: '4px 10px', borderRadius: '4px', fontSize: '0.75rem',
              background: status.type === 'success' ? '#d1fae5' : status.type === 'error' ? '#fecaca' : '#e2e8f0',
              color: status.type === 'success' ? colors.success : status.type === 'error' ? colors.error : colors.textMuted
            }}>{status.msg}</span>
          )}
          <span style={{
            padding: '4px 8px', borderRadius: '4px', fontSize: '0.7rem',
            background: tasConfig.enabled ? '#d1fae5' : '#fecaca',
            color: tasConfig.enabled ? colors.success : colors.error
          }}>{tasConfig.enabled ? 'TAS ON' : 'TAS OFF'}</span>
        </div>
      </div>

      {/* Network Topology */}
      <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '12px', color: colors.text }}>Network Path</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', fontSize: '0.75rem' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '8px 12px', background: '#e0f2fe', borderRadius: '4px', fontFamily: 'monospace', marginBottom: '4px' }}>
              {TX_INTERFACE}
            </div>
            <div style={{ color: colors.textMuted }}>TX Interface</div>
          </div>
          <div style={{ color: colors.textLight }}>→</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '8px 12px', background: colors.card, border: `2px solid ${colors.accent}`, borderRadius: '4px', marginBottom: '4px' }}>
              <div style={{ fontWeight: '600' }}>LAN9662</div>
              <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>{board?.device || '/dev/ttyACM0'}</div>
            </div>
            <div style={{ color: colors.textMuted }}>Switch</div>
          </div>
          <div style={{ color: colors.textLight }}>→</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '8px 12px', background: '#fef3c7', borderRadius: '4px', marginBottom: '4px' }}>
              <div style={{ fontFamily: 'monospace' }}>Port {outputPort}</div>
              <div style={{ fontSize: '0.65rem', color: colors.warning }}>TAS Applied</div>
            </div>
            <div style={{ color: colors.textMuted }}>Output Port</div>
          </div>
          <div style={{ color: colors.textLight }}>→</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '8px 12px', background: '#dcfce7', borderRadius: '4px', fontFamily: 'monospace', marginBottom: '4px' }}>
              {RX_INTERFACE}
            </div>
            <div style={{ color: colors.textMuted }}>RX Interface</div>
          </div>
        </div>
      </div>

      {/* Status Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', marginBottom: '16px' }}>
        {[
          { label: 'Cycle Time', value: `${currentCycleMs.toFixed(0)} ms` },
          { label: 'Guard Band', value: `${tasConfig.guardNs} ns` },
          { label: 'Slots', value: tasConfig.gcl?.length || 8 },
          { label: 'Slot Time', value: `${(currentCycleMs / (tasConfig.gcl?.length || 8)).toFixed(1)} ms` },
          { label: 'Status', value: tasConfig.enabled ? 'Enabled' : 'Disabled', color: tasConfig.enabled ? colors.success : colors.textMuted },
        ].map((item, i) => (
          <div key={i} style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '12px' }}>
            <div style={{ fontSize: '0.6rem', color: colors.textMuted, marginBottom: '4px' }}>{item.label}</div>
            <div style={{ fontSize: '0.9rem', fontFamily: 'monospace', fontWeight: '600', color: item.color || colors.text }}>{item.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        {/* Test Configuration */}
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '16px' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '12px', color: colors.text }}>Test Configuration</div>

          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '0.7rem', color: colors.textMuted, marginBottom: '6px' }}>Traffic Classes</div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {[0,1,2,3,4,5,6,7].map(tc => (
                <button key={tc} onClick={() => !testing && setSelectedTCs(p => p.includes(tc) ? p.filter(t => t !== tc) : [...p, tc].sort())}
                  disabled={testing}
                  style={{
                    padding: '4px 10px', borderRadius: '3px', fontSize: '0.75rem', fontWeight: '500',
                    border: `1px solid ${selectedTCs.includes(tc) ? tcColors[tc] : colors.border}`,
                    background: selectedTCs.includes(tc) ? `${tcColors[tc]}15` : colors.card,
                    color: selectedTCs.includes(tc) ? tcColors[tc] : colors.textLight,
                    cursor: testing ? 'not-allowed' : 'pointer'
                  }}>TC{tc}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '12px' }}>
            {[
              ['VLAN', vlanId, setVlanId],
              ['PPS/TC', pps, setPps],
              ['Duration (s)', duration, setDuration],
              ['Output Port', outputPort, setOutputPort],
            ].map(([label, val, setter]) => (
              <div key={label}>
                <div style={{ fontSize: '0.65rem', color: colors.textMuted, marginBottom: '3px' }}>{label}</div>
                <input type={label === 'Output Port' ? 'text' : 'number'} value={val}
                  onChange={e => setter(label === 'Output Port' ? e.target.value : +e.target.value)}
                  disabled={testing}
                  style={{ width: '100%', padding: '4px 6px', borderRadius: '3px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '0.8rem' }} />
              </div>
            ))}
          </div>

          <button onClick={runTest} disabled={testing || selectedTCs.length === 0 || !wsConnected}
            style={{
              width: '100%', padding: '8px', borderRadius: '4px', fontWeight: '600', fontSize: '0.8rem',
              background: testing ? colors.textLight : colors.accent, color: '#fff', border: 'none',
              cursor: testing || selectedTCs.length === 0 ? 'not-allowed' : 'pointer'
            }}>
            {testing ? 'Testing...' : 'Run Test'}
          </button>
        </div>

        {/* TAS Configuration */}
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '16px' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '12px', color: colors.text }}>TAS Parameters</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '12px' }}>
            <div>
              <div style={{ fontSize: '0.65rem', color: colors.textMuted, marginBottom: '3px' }}>Cycle Time (ms)</div>
              <input type="number" value={cycleMs} onChange={e => setCycleMs(+e.target.value)}
                style={{ width: '100%', padding: '4px 6px', borderRadius: '3px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '0.8rem' }} />
            </div>
            <div>
              <div style={{ fontSize: '0.65rem', color: colors.textMuted, marginBottom: '3px' }}>Guard Band (ns)</div>
              <input type="number" value={guardNs} onChange={e => setGuardNs(+e.target.value)}
                style={{ width: '100%', padding: '4px 6px', borderRadius: '3px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '0.8rem' }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <button onClick={applyTAS} disabled={!board || testing}
              style={{ flex: 1, padding: '6px', background: colors.accent, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '500', cursor: 'pointer' }}>
              Apply TAS
            </button>
            <button onClick={disableTAS} disabled={!board || testing}
              style={{ flex: 1, padding: '6px', background: colors.textLight, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '500', cursor: 'pointer' }}>
              Disable
            </button>
            <button onClick={fetchTAS} disabled={!board}
              style={{ flex: 1, padding: '6px', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: '4px', fontSize: '0.75rem', fontWeight: '500', cursor: 'pointer' }}>
              Refresh
            </button>
          </div>

          {stats && (
            <button onClick={applyEstimation}
              style={{ width: '100%', padding: '6px', background: colors.success, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '500', cursor: 'pointer' }}>
              Apply Estimation
            </button>
          )}
        </div>
      </div>

      {/* Packet Timeline */}
      <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: '600', color: colors.text }}>Packet Timeline</div>
          <div style={{ fontSize: '0.7rem', color: colors.textMuted, fontFamily: 'monospace' }}>{packets.length} packets</div>
        </div>
        <PacketTimeline packets={packets} maxTime={maxTime} />
      </div>

      {/* GCL Comparison */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        <GCLHeatmap gcl={tasConfig.gcl} title="Current GCL" active={tasConfig.enabled} />
        <GCLEstimationHeatmap stats={stats} selectedTCs={selectedTCs} cycleMs={cycleMs} />
      </div>

      {/* Results Table */}
      {stats && (
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '16px' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '12px', color: colors.text }}>Measurement Results</div>
          <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: colors.bg }}>
                <th style={{ padding: '6px', textAlign: 'left' }}>TC</th>
                <th style={{ padding: '6px', textAlign: 'right' }}>Packets</th>
                <th style={{ padding: '6px', textAlign: 'right' }}>Avg Interval</th>
                <th style={{ padding: '6px', textAlign: 'right' }}>Std Dev</th>
                <th style={{ padding: '6px', textAlign: 'right' }}>Bandwidth</th>
                <th style={{ padding: '6px', textAlign: 'center' }}>Gating</th>
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
                    <td style={{ padding: '6px', fontWeight: '500', color: tcColors[tc] }}>TC{tc}</td>
                    <td style={{ padding: '6px', textAlign: 'right', fontFamily: 'monospace' }}>{data.count}</td>
                    <td style={{ padding: '6px', textAlign: 'right', fontFamily: 'monospace' }}>{avgMs?.toFixed(2)} ms</td>
                    <td style={{ padding: '6px', textAlign: 'right', fontFamily: 'monospace' }}>{(data.stddev_ms || 0).toFixed(2)} ms</td>
                    <td style={{ padding: '6px', textAlign: 'right', fontFamily: 'monospace' }}>{(data.kbps || 0).toFixed(1)} kbps</td>
                    <td style={{ padding: '6px', textAlign: 'center' }}>
                      <span style={{
                        padding: '2px 6px', borderRadius: '3px', fontSize: '0.65rem',
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
