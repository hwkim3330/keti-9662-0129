import { useState, useEffect, useRef, useMemo } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

// Interface configuration
const TX_INTERFACE = 'enxc84d44263ba6'
const RX_INTERFACE = 'enx00e04c6812d1'
const DST_MAC = '00:e0:4c:68:12:d1'
const API_BASE = 'http://localhost:3000'

// Color palette (toned down - matching TAS)
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

// Packet timing visualization (dots on timeline)
const PacketTimeline = ({ packets, maxTime, height = 160 }) => {
  const width = 800
  const pad = { top: 16, right: 16, bottom: 28, left: 48 }
  const chartW = width - pad.left - pad.right
  const chartH = height - pad.top - pad.bottom
  const rowH = chartH / 8

  const xScale = (t) => pad.left + Math.min(t / maxTime, 1) * chartW

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', background: colors.card }}>
      {/* TC rows */}
      {[0,1,2,3,4,5,6,7].map(tc => (
        <g key={tc}>
          <rect x={pad.left} y={pad.top + tc * rowH} width={chartW} height={rowH}
            fill={tc % 2 === 0 ? '#f8fafc' : '#fff'} stroke={colors.border} strokeWidth="0.5" />
          <text x={pad.left - 6} y={pad.top + tc * rowH + rowH/2 + 3}
            textAnchor="end" fontSize="9" fill={tcColors[tc]} fontWeight="500">TC{tc}</text>
        </g>
      ))}

      {/* Time axis */}
      {[0, 1, 2, 3, 4, 5].map(s => {
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

      {/* Packets as vertical ticks */}
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

// Bandwidth estimation heatmap
const BandwidthHeatmap = ({ stats, idleSlopes, selectedTCs }) => {
  if (!stats) return null

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
      {selectedTCs.map(tc => {
        const s = stats[tc]
        if (!s) return null
        const measured = s.kbps || 0
        const slope = idleSlopes[tc] || 1000000
        const ratio = slope < 1000000 ? (measured / slope * 100).toFixed(0) : 100
        const shaped = measured < slope * 0.9 && slope < 1000000

        return (
          <div key={tc} style={{
            padding: '10px', borderRadius: '4px', border: `1px solid ${colors.border}`,
            background: shaped ? '#fef2f2' : colors.card
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span style={{ fontWeight: '600', color: tcColors[tc], fontSize: '0.8rem' }}>TC{tc}</span>
              <span style={{
                fontSize: '0.65rem', padding: '2px 6px', borderRadius: '3px',
                background: shaped ? '#fecaca' : '#d1fae5',
                color: shaped ? colors.error : colors.success
              }}>{shaped ? 'SHAPED' : 'OK'}</span>
            </div>
            <div style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: colors.text }}>
              <div>Measured: {measured.toFixed(1)} kbps</div>
              <div style={{ color: colors.textMuted }}>Slope: {slope < 1000000 ? `${slope} kbps` : 'unlimited'}</div>
              <div style={{ color: colors.textMuted }}>Ratio: {ratio}%</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CBSDashboard() {
  const { devices } = useDevices()
  const [status, setStatus] = useState(null)
  const [testing, setTesting] = useState(false)
  const [packets, setPackets] = useState([])
  const [stats, setStats] = useState(null)
  const [estimation, setEstimation] = useState(null)

  const [selectedTCs, setSelectedTCs] = useState([1, 2, 3])
  const [vlanId, setVlanId] = useState(100)
  const [pps, setPps] = useState(200)
  const [duration, setDuration] = useState(5)
  const [outputPort, setOutputPort] = useState('1')

  // Idle slope settings (kbps)
  const [idleSlopes, setIdleSlopes] = useState({
    0: 1000000, 1: 50, 2: 100, 3: 150, 4: 200, 5: 250, 6: 300, 7: 350
  })

  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef(null)
  const startTimeRef = useRef(null)
  const packetsRef = useRef([])

  const board = devices.find(d => d.device?.includes('ACM'))
  const getQosPath = (port) => `/ietf-interfaces:interfaces/interface[name='${port}']/mchp-velocitysp-port:eth-qos/config`

  // WebSocket connection
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
            const analysis = msg.stats.analysis || msg.stats.tc
            setStats(analysis)
            calculateEstimation(analysis)
            setTesting(false)
          }
        } catch {}
      }
      wsRef.current = ws
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  // Calculate idle slope estimation
  const calculateEstimation = (analysis) => {
    if (!analysis) return
    const est = {}
    selectedTCs.forEach(tc => {
      const data = analysis[tc]
      if (!data) return
      const measured = data.kbps || 0
      const stddev = data.stddev_ms || 0
      // If shaped, estimate slope from measured bandwidth
      // Add 10% margin for estimation
      est[tc] = {
        measured,
        estimated: Math.round(measured * 1.1),
        stddev,
        confidence: stddev < 5 ? 'high' : stddev < 10 ? 'medium' : 'low'
      }
    })
    setEstimation(est)
  }

  // Apply CBS configuration
  const applyCBS = async () => {
    if (!board) return
    setStatus({ type: 'info', msg: 'Applying CBS...' })
    try {
      const patches = selectedTCs.map(tc => ({
        path: `${getQosPath(outputPort)}/traffic-class-shapers`,
        value: { 'traffic-class': tc, 'credit-based': { 'idle-slope': idleSlopes[tc] || 1000000 } }
      }))
      await axios.post('/api/patch', {
        patches,
        transport: board.transport || 'serial',
        device: board.device
      }, { timeout: 30000 })
      setStatus({ type: 'success', msg: 'CBS applied to port ' + outputPort })
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

  // Reset CBS (unlimited)
  const resetCBS = async () => {
    if (!board) return
    setStatus({ type: 'info', msg: 'Resetting CBS...' })
    try {
      const patches = [0,1,2,3,4,5,6,7].map(tc => ({
        path: `${getQosPath(outputPort)}/traffic-class-shapers`,
        value: { 'traffic-class': tc, 'credit-based': { 'idle-slope': 1000000 } }
      }))
      await axios.post('/api/patch', { patches, transport: board.transport || 'serial', device: board.device }, { timeout: 30000 })
      setIdleSlopes({ 0: 1000000, 1: 1000000, 2: 1000000, 3: 1000000, 4: 1000000, 5: 1000000, 6: 1000000, 7: 1000000 })
      setStatus({ type: 'success', msg: 'CBS reset (unlimited)' })
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

  // Apply estimation
  const applyEstimation = async () => {
    if (!estimation || !board) return
    const newSlopes = { ...idleSlopes }
    Object.entries(estimation).forEach(([tc, data]) => {
      newSlopes[tc] = data.estimated
    })
    setIdleSlopes(newSlopes)
    setStatus({ type: 'info', msg: 'Applying estimation...' })
    try {
      const patches = Object.entries(estimation).map(([tc, data]) => ({
        path: `${getQosPath(outputPort)}/traffic-class-shapers`,
        value: { 'traffic-class': parseInt(tc), 'credit-based': { 'idle-slope': data.estimated } }
      }))
      await axios.post('/api/patch', { patches, transport: board.transport || 'serial', device: board.device }, { timeout: 30000 })
      setStatus({ type: 'success', msg: 'Estimation applied' })
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

  // Run test
  const runTest = async () => {
    if (selectedTCs.length === 0 || testing) return
    packetsRef.current = []
    setPackets([])
    setStats(null)
    setEstimation(null)
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

  return (
    <div style={{ padding: '20px', background: colors.bg, minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: '600', margin: 0, color: colors.text }}>CBS Configuration</h1>
          <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginTop: '4px' }}>
            Credit-Based Shaper - IEEE 802.1Qav
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
            background: wsConnected ? '#d1fae5' : '#fecaca',
            color: wsConnected ? colors.success : colors.error
          }}>{wsConnected ? 'WS OK' : 'WS ERR'}</span>
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
              <div style={{ fontSize: '0.65rem', color: colors.warning }}>CBS Applied</div>
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

        {/* CBS Configuration */}
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '16px' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '12px', color: colors.text }}>Idle Slope (kbps)</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
            {selectedTCs.map(tc => (
              <div key={tc}>
                <div style={{ fontSize: '0.65rem', color: tcColors[tc], fontWeight: '500', marginBottom: '2px' }}>TC{tc}</div>
                <input type="number" value={idleSlopes[tc] || ''}
                  onChange={e => setIdleSlopes(p => ({ ...p, [tc]: +e.target.value }))}
                  style={{ width: '100%', padding: '4px', borderRadius: '3px', border: `1px solid ${tcColors[tc]}40`, fontFamily: 'monospace', fontSize: '0.75rem' }} />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={applyCBS} disabled={!board || testing}
              style={{ flex: 1, padding: '6px', background: colors.accent, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '500', cursor: 'pointer' }}>
              Apply CBS
            </button>
            <button onClick={resetCBS} disabled={!board || testing}
              style={{ flex: 1, padding: '6px', background: colors.textLight, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '500', cursor: 'pointer' }}>
              Reset
            </button>
          </div>
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

      {/* Results */}
      {stats && (
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '12px', color: colors.text }}>Measurement Results</div>
          <BandwidthHeatmap stats={stats} idleSlopes={idleSlopes} selectedTCs={selectedTCs} />
        </div>
      )}

      {/* Estimation */}
      {estimation && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '6px', padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: '600', color: '#166534' }}>Idle Slope Estimation</div>
            <button onClick={applyEstimation}
              style={{ padding: '6px 12px', background: colors.success, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '500', cursor: 'pointer' }}>
              Apply to Board
            </button>
          </div>
          <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#dcfce7' }}>
                <th style={{ padding: '6px', textAlign: 'left' }}>TC</th>
                <th style={{ padding: '6px', textAlign: 'right' }}>Measured</th>
                <th style={{ padding: '6px', textAlign: 'right' }}>Estimated</th>
                <th style={{ padding: '6px', textAlign: 'right' }}>Std Dev</th>
                <th style={{ padding: '6px', textAlign: 'center' }}>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(estimation).map(([tc, data]) => (
                <tr key={tc} style={{ borderBottom: '1px solid #bbf7d0' }}>
                  <td style={{ padding: '6px', fontWeight: '500', color: tcColors[tc] }}>TC{tc}</td>
                  <td style={{ padding: '6px', textAlign: 'right', fontFamily: 'monospace' }}>{data.measured.toFixed(1)} kbps</td>
                  <td style={{ padding: '6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>{data.estimated} kbps</td>
                  <td style={{ padding: '6px', textAlign: 'right', fontFamily: 'monospace' }}>{data.stddev.toFixed(2)} ms</td>
                  <td style={{ padding: '6px', textAlign: 'center' }}>
                    <span style={{
                      padding: '2px 6px', borderRadius: '3px', fontSize: '0.65rem',
                      background: data.confidence === 'high' ? '#d1fae5' : data.confidence === 'medium' ? '#fef3c7' : '#fecaca',
                      color: data.confidence === 'high' ? colors.success : data.confidence === 'medium' ? colors.warning : colors.error
                    }}>{data.confidence}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default CBSDashboard
