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

function CBSDashboard() {
  const { devices } = useDevices()
  const [status, setStatus] = useState(null)
  const [testing, setTesting] = useState(false)
  const [txPackets, setTxPackets] = useState([])
  const [rxPackets, setRxPackets] = useState([])
  const [stats, setStats] = useState(null)
  const [estimation, setEstimation] = useState(null)

  const [selectedTCs, setSelectedTCs] = useState([1, 2, 3])
  const [vlanId, setVlanId] = useState(100)
  const [pps, setPps] = useState(200)
  const [duration, setDuration] = useState(5)
  const [outputPort, setOutputPort] = useState('1')

  const [idleSlopes, setIdleSlopes] = useState({
    0: 1000000, 1: 50, 2: 100, 3: 150, 4: 200, 5: 250, 6: 300, 7: 350
  })

  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef(null)
  const startTimeRef = useRef(null)
  const txPacketsRef = useRef([])
  const rxPacketsRef = useRef([])

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

  const calculateEstimation = (analysis) => {
    if (!analysis) return
    const est = {}
    selectedTCs.forEach(tc => {
      const data = analysis[tc]
      if (!data) return
      const measured = data.kbps || 0
      const stddev = data.stddev_ms || 0
      est[tc] = {
        measured,
        estimated: Math.round(measured * 1.1),
        stddev,
        confidence: stddev < 5 ? 'high' : stddev < 10 ? 'medium' : 'low'
      }
    })
    setEstimation(est)
  }

  const applyCBS = async () => {
    if (!board) return
    setStatus({ type: 'info', msg: 'Applying CBS...' })
    try {
      const patches = selectedTCs.map(tc => ({
        path: `${getQosPath(outputPort)}/traffic-class-shapers`,
        value: { 'traffic-class': tc, 'credit-based': { 'idle-slope': idleSlopes[tc] || 1000000 } }
      }))
      await axios.post('/api/patch', { patches, transport: board.transport || 'serial', device: board.device }, { timeout: 30000 })
      setStatus({ type: 'success', msg: 'CBS applied to port ' + outputPort })
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

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
      setStatus({ type: 'success', msg: 'CBS reset' })
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

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

  // Simulate TX packets based on PPS
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

  const runTest = async () => {
    if (selectedTCs.length === 0 || testing) return
    txPacketsRef.current = []
    rxPacketsRef.current = []
    setTxPackets([])
    setRxPackets([])
    setStats(null)
    setEstimation(null)
    startTimeRef.current = Date.now()
    setTesting(true)
    setStatus({ type: 'info', msg: 'Starting test...' })

    try {
      await axios.post('/api/capture/stop-c').catch(() => {})
      await new Promise(r => setTimeout(r, 300))

      await axios.post('/api/capture/start-c', { interface: RX_INTERFACE, duration: duration + 3, vlanId })
      await new Promise(r => setTimeout(r, 500))

      setStatus({ type: 'info', msg: 'Sending traffic...' })

      // Generate TX packets visualization
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
          calculateEstimation(res.data.stats.tc)
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

  return (
    <div style={{ padding: '16px', background: colors.bg, minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <h1 style={{ fontSize: '1.1rem', fontWeight: '600', margin: 0, color: colors.text }}>CBS Configuration</h1>
          <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>Credit-Based Shaper - IEEE 802.1Qav</div>
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
            background: wsConnected ? '#d1fae5' : '#fecaca',
            color: wsConnected ? colors.success : colors.error
          }}>{wsConnected ? 'WS' : 'ERR'}</span>
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
              <div style={{ fontSize: '0.55rem', color: colors.warning }}>CBS</div>
            </div>
          </div>
          <div style={{ color: colors.textLight }}>→</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '6px 10px', background: '#dcfce7', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.65rem' }}>{RX_INTERFACE}</div>
            <div style={{ color: colors.textMuted, fontSize: '0.6rem', marginTop: '2px' }}>RX</div>
          </div>
        </div>
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

        {/* CBS Config */}
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '12px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: '600', marginBottom: '8px', color: colors.text }}>Idle Slope (kbps)</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', marginBottom: '8px' }}>
            {selectedTCs.map(tc => (
              <div key={tc}>
                <div style={{ fontSize: '0.6rem', color: tcColors[tc], fontWeight: '500', marginBottom: '1px' }}>TC{tc}</div>
                <input type="number" value={idleSlopes[tc] || ''}
                  onChange={e => setIdleSlopes(p => ({ ...p, [tc]: +e.target.value }))}
                  style={{ width: '100%', padding: '3px', borderRadius: '2px', border: `1px solid ${tcColors[tc]}40`, fontFamily: 'monospace', fontSize: '0.7rem' }} />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={applyCBS} disabled={!board || testing}
              style={{ flex: 1, padding: '5px', background: colors.accent, color: '#fff', border: 'none', borderRadius: '3px', fontSize: '0.7rem', fontWeight: '500', cursor: 'pointer' }}>
              Apply CBS
            </button>
            <button onClick={resetCBS} disabled={!board || testing}
              style={{ flex: 1, padding: '5px', background: colors.textLight, color: '#fff', border: 'none', borderRadius: '3px', fontSize: '0.7rem', fontWeight: '500', cursor: 'pointer' }}>
              Reset
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

      {/* Results */}
      {stats && (
        <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: '4px', padding: '12px', marginBottom: '12px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: '600', marginBottom: '8px', color: colors.text }}>Results</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
            {selectedTCs.map(tc => {
              const s = stats[tc]
              if (!s) return null
              const measured = s.kbps || 0
              const slope = idleSlopes[tc] || 1000000
              const shaped = measured < slope * 0.9 && slope < 1000000
              return (
                <div key={tc} style={{ padding: '8px', borderRadius: '3px', border: `1px solid ${colors.border}`, background: shaped ? '#fef2f2' : colors.card }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontWeight: '600', color: tcColors[tc], fontSize: '0.75rem' }}>TC{tc}</span>
                    <span style={{ fontSize: '0.6rem', padding: '1px 4px', borderRadius: '2px', background: shaped ? '#fecaca' : '#d1fae5', color: shaped ? colors.error : colors.success }}>
                      {shaped ? 'SHAPED' : 'OK'}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: colors.text }}>
                    <div>{measured.toFixed(1)} kbps</div>
                    <div style={{ color: colors.textMuted }}>{s.count} pkts</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Estimation */}
      {estimation && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '4px', padding: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: '600', color: '#166534' }}>Idle Slope Estimation</div>
            <button onClick={applyEstimation}
              style={{ padding: '4px 10px', background: colors.success, color: '#fff', border: 'none', borderRadius: '3px', fontSize: '0.7rem', fontWeight: '500', cursor: 'pointer' }}>
              Apply
            </button>
          </div>
          <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#dcfce7' }}>
                <th style={{ padding: '4px', textAlign: 'left' }}>TC</th>
                <th style={{ padding: '4px', textAlign: 'right' }}>Measured</th>
                <th style={{ padding: '4px', textAlign: 'right' }}>Estimated</th>
                <th style={{ padding: '4px', textAlign: 'center' }}>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(estimation).map(([tc, data]) => (
                <tr key={tc} style={{ borderBottom: '1px solid #bbf7d0' }}>
                  <td style={{ padding: '4px', fontWeight: '500', color: tcColors[tc] }}>TC{tc}</td>
                  <td style={{ padding: '4px', textAlign: 'right', fontFamily: 'monospace' }}>{data.measured.toFixed(1)} kbps</td>
                  <td style={{ padding: '4px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>{data.estimated} kbps</td>
                  <td style={{ padding: '4px', textAlign: 'center' }}>
                    <span style={{
                      padding: '1px 4px', borderRadius: '2px', fontSize: '0.6rem',
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
