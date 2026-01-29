import { useState, useEffect, useRef, useMemo } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

const TAP_INTERFACE = 'enx00e04c6812d1'
const TRAFFIC_INTERFACE = 'enxc84d44263ba6'
const BOARD2_PORT8_MAC = '00:e0:4c:68:12:d1'
const TRAFFIC_API = 'http://localhost:3000'

const colors = {
  text: '#1f2937',
  textMuted: '#6b7280',
  textLight: '#9ca3af',
  bg: '#f9fafb',
  bgAlt: '#f3f4f6',
  border: '#e5e7eb',
  success: '#059669',
  warning: '#d97706',
  error: '#dc2626',
  tx: '#3b82f6',
  rx: '#10b981',
  grid: '#e5e7eb',
}

const tcColors = [
  '#94a3b8', '#64748b', '#475569', '#334155',
  '#1e3a5f', '#1e40af', '#3730a3', '#4c1d95'
]

// TC별 래스터 그래프 (Y축: TC, X축: 시간) - 고정 X축
const TCRasterGraph = ({ data, selectedTCs, title, color, maxTime, totalPackets }) => {
  const width = 600
  const height = 200
  const padding = { top: 16, right: 16, bottom: 32, left: 45 }
  const chartW = width - padding.left - padding.right
  const chartH = height - padding.top - padding.bottom
  const rowH = chartH / 8

  // X축 스케일 (시간) - 고정 maxTime 사용
  const xScale = (time) => padding.left + Math.min(time / maxTime, 1) * chartW

  // X축 틱 (1초 단위)
  const xTicks = useMemo(() => {
    const ticks = []
    const step = 1000
    for (let i = 0; i <= maxTime; i += step) ticks.push(i)
    return ticks
  }, [maxTime])

  // 최대 패킷 수
  const maxPkts = useMemo(() => {
    if (!data.length) return 10
    let max = 0
    data.forEach(d => {
      for (let tc = 0; tc < 8; tc++) {
        if ((d.tc[tc] || 0) > max) max = d.tc[tc]
      }
    })
    return Math.max(max, 1)
  }, [data])

  // 막대 너비 계산 (500ms 간격 기준)
  const barW = Math.max((chartW / (maxTime / 500)) - 2, 4)

  return (
    <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: color }} />
          <span style={{ fontWeight: '600', fontSize: '0.85rem' }}>{title}</span>
        </div>
        <span style={{ fontSize: '0.7rem', color: colors.textMuted, fontFamily: 'monospace' }}>
          {totalPackets > 0 ? `${totalPackets} pkts` : 'Waiting...'}
        </span>
      </div>

      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {/* Y축 TC 라벨 및 배경 */}
        {[0,1,2,3,4,5,6,7].map(tc => {
          const y = padding.top + tc * rowH
          const isSelected = selectedTCs.includes(tc)
          return (
            <g key={tc}>
              <rect x={padding.left} y={y} width={chartW} height={rowH}
                fill={isSelected ? `${tcColors[tc]}10` : '#fafafa'}
                stroke={colors.border} strokeWidth="0.5" />
              <text x={padding.left - 6} y={y + rowH / 2} textAnchor="end"
                alignmentBaseline="middle" fontSize="9" fontWeight="600"
                fill={isSelected ? tcColors[tc] : colors.textLight}>
                TC{tc}
              </text>
            </g>
          )
        })}

        {/* X축 그리드 및 라벨 (1초 단위) */}
        {xTicks.map(tick => (
          <g key={tick}>
            <line x1={xScale(tick)} y1={padding.top} x2={xScale(tick)} y2={height - padding.bottom}
              stroke={colors.grid} strokeDasharray="2,2" strokeWidth="0.5" />
            <text x={xScale(tick)} y={height - padding.bottom + 12} textAnchor="middle"
              fontSize="8" fill={colors.textMuted}>{tick / 1000}s</text>
          </g>
        ))}

        {/* 데이터 막대 */}
        {data.map((d, i) => {
          const x = xScale(d.time)
          if (x < padding.left || x > width - padding.right) return null
          return (
            <g key={i}>
              {[0,1,2,3,4,5,6,7].map(tc => {
                const count = d.tc[tc] || 0
                if (count === 0) return null
                const y = padding.top + tc * rowH + 1
                const intensity = Math.min(count / maxPkts, 1)
                return (
                  <rect key={tc} x={x - barW/2} y={y} width={barW} height={rowH - 2}
                    fill={tcColors[tc]} opacity={0.4 + intensity * 0.6} rx="1" />
                )
              })}
            </g>
          )
        })}

        {/* 축 테두리 */}
        <rect x={padding.left} y={padding.top} width={chartW} height={chartH}
          fill="none" stroke={colors.border} strokeWidth="1" />
      </svg>

      {/* TC별 총합 */}
      <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
        {selectedTCs.map(tc => {
          const total = data.reduce((sum, d) => sum + (d.tc[tc] || 0), 0)
          return (
            <span key={tc} style={{ fontSize: '0.65rem', fontFamily: 'monospace', padding: '2px 5px', borderRadius: '3px', background: `${tcColors[tc]}15`, color: tcColors[tc] }}>
              TC{tc}:{total}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function TASDashboard() {
  const { devices } = useDevices()
  const [tasData, setTasData] = useState({})
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState(null)

  const [trafficInterface, setTrafficInterface] = useState(null)
  const [trafficRunning, setTrafficRunning] = useState(false)
  const [selectedTCs, setSelectedTCs] = useState([1, 2, 3, 4, 5, 6, 7])
  const [vlanId, setVlanId] = useState(100)
  const [pps, setPps] = useState(100)
  const [duration, setDuration] = useState(7)

  const [tapConnected, setTapConnected] = useState(false)
  const [rxStats, setRxStats] = useState(null)
  const [txHistory, setTxHistory] = useState([])
  const [rxHistory, setRxHistory] = useState([])
  const [startTime, setStartTime] = useState(null)
  const wsRef = useRef(null)

  const board = devices.find(d => d.name?.includes('#1') || d.device?.includes('ACM0')) ||
                devices.find(d => d.name?.includes('#2') || d.device?.includes('ACM1'))
  const PORT = 8
  const basePath = `/ietf-interfaces:interfaces/interface[name='${PORT}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table`

  const fetchTAS = async () => {
    if (!board) return
    setLoading(true)
    try {
      const res = await axios.post('/api/fetch', {
        paths: [basePath],
        transport: board.transport || 'serial',
        device: board.device, host: board.host, port: board.port || 5683
      }, { timeout: 15000 })

      const yaml = res.data?.result || ''
      const data = { enabled: /gate-enabled:\s*true/.test(yaml), cycleNs: 0, guard: 0, gcl: [], online: true }

      const cycleMatch = yaml.match(/admin-cycle-time:[\s\S]*?numerator:\s*(\d+)/)
      if (cycleMatch) data.cycleNs = parseInt(cycleMatch[1])

      const guardMatch = yaml.match(/admin-cycle-time-extension:\s*(\d+)/)
      if (guardMatch) data.guard = parseInt(guardMatch[1])

      const gclMatch = yaml.match(/admin-control-list:[\s\S]*?gate-control-entry:([\s\S]*?)(?=oper-|$)/)
      if (gclMatch) {
        const entries = [...gclMatch[1].matchAll(/gate-states-value:\s*(\d+)[\s\S]*?time-interval-value:\s*(\d+)/g)]
        data.gcl = entries.map(m => ({ gates: parseInt(m[1]), time: parseInt(m[2]) }))
      }
      setTasData(data)
    } catch { setTasData({ online: false }) }
    setLoading(false)
  }

  const configureTAS = async () => {
    if (!board) return
    setStatus({ type: 'info', msg: 'Configuring...' })
    try {
      const entries = []
      for (let i = 1; i <= 7; i++) {
        entries.push({ index: i - 1, 'operation-name': 'ieee802-dot1q-sched:set-gate-states', 'time-interval-value': 125000000, 'gate-states-value': (1 << i) | 1 })
      }
      entries.push({ index: 7, 'operation-name': 'ieee802-dot1q-sched:set-gate-states', 'time-interval-value': 125000000, 'gate-states-value': 1 })

      await axios.post('/api/patch', {
        patches: [
          { path: `${basePath}/gate-enabled`, value: true },
          { path: `${basePath}/admin-gate-states`, value: 255 },
          { path: `${basePath}/admin-control-list/gate-control-entry`, value: entries },
          { path: `${basePath}/admin-cycle-time/numerator`, value: 1000000000 },
          { path: `${basePath}/admin-cycle-time/denominator`, value: 1 },
          { path: `${basePath}/admin-cycle-time-extension`, value: 256 },
        ],
        transport: board.transport, device: board.device, host: board.host
      }, { timeout: 30000 })

      await axios.post('/api/patch', {
        patches: [{ path: `${basePath}/config-change`, value: true }],
        transport: board.transport, device: board.device, host: board.host
      }, { timeout: 10000 })

      setStatus({ type: 'success', msg: 'Configured' })
      setTimeout(() => { fetchTAS(); setStatus(null) }, 1500)
    } catch (err) { setStatus({ type: 'error', msg: err.message }) }
  }

  const disableTAS = async () => {
    if (!board) return
    setStatus({ type: 'info', msg: 'Disabling...' })
    try {
      await axios.post('/api/patch', {
        patches: [{ path: `${basePath}/gate-enabled`, value: false }],
        transport: board.transport, device: board.device, host: board.host
      }, { timeout: 15000 })
      setStatus({ type: 'success', msg: 'Disabled' })
      setTimeout(() => { fetchTAS(); setStatus(null) }, 1500)
    } catch (err) { setStatus({ type: 'error', msg: err.message }) }
  }

  useEffect(() => { if (board) fetchTAS() }, [board])

  useEffect(() => {
    setTrafficInterface(TRAFFIC_INTERFACE)
  }, [])

  // WebSocket for RX capture data
  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/capture`)
      ws.onopen = () => setTapConnected(true)
      ws.onclose = () => { setTapConnected(false); setTimeout(connect, 3000) }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'c-capture-stats') {
            setRxStats(msg.data)
            // startTime 기준으로 시간 계산 (TX와 동기화)
            if (startTime) {
              const elapsed = Date.now() - startTime
              setRxHistory(prev => {
                const newEntry = { time: elapsed, tc: {} }
                for (let tc = 0; tc < 8; tc++) {
                  const current = msg.data.tc?.[tc]?.count || 0
                  const prevTotal = prev.length > 0 ? prev.reduce((sum, d) => sum + (d.tc[tc] || 0), 0) : 0
                  newEntry.tc[tc] = Math.max(0, current - prevTotal)
                }
                return [...prev.slice(-60), newEntry]
              })
            }
          } else if (msg.type === 'c-capture-stopped' && msg.stats?.analysis) {
            setRxStats(prev => ({ ...prev, final: true, analysis: msg.stats.analysis }))
          }
        } catch {}
      }
      wsRef.current = ws
    }
    connect()
    return () => wsRef.current?.close()
  }, [startTime])

  // TX 시뮬레이션
  useEffect(() => {
    if (!trafficRunning || !startTime) return
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime
      setTxHistory(prev => {
        const newEntry = { time: elapsed, tc: {} }
        const ppsPerTc = pps / selectedTCs.length
        const packetsPerInterval = ppsPerTc * 0.5
        selectedTCs.forEach(tc => { newEntry.tc[tc] = Math.round(packetsPerInterval) })
        return [...prev.slice(-60), newEntry]
      })
    }, 500)
    return () => clearInterval(interval)
  }, [trafficRunning, pps, selectedTCs, startTime])

  const startTest = async () => {
    if (!trafficInterface || selectedTCs.length === 0) return
    setRxStats(null)
    setTxHistory([])
    setRxHistory([])
    const now = Date.now()
    setStartTime(now)
    try {
      await axios.post('/api/capture/start-c', { interface: TAP_INTERFACE, duration: duration + 2, vlanId })
      await new Promise(r => setTimeout(r, 500))
      setTrafficRunning(true)
      // 초기 TX 엔트리 추가
      const initEntry = { time: 0, tc: {} }
      selectedTCs.forEach(tc => { initEntry.tc[tc] = 0 })
      setTxHistory([initEntry])
      setRxHistory([{ time: 0, tc: {} }])
      await axios.post(`${TRAFFIC_API}/api/traffic/start-precision`, {
        interface: trafficInterface, dstMac: BOARD2_PORT8_MAC, vlanId, tcList: selectedTCs, packetsPerSecond: pps, duration
      })
      setTimeout(stopTest, (duration + 3) * 1000)
    } catch (err) { console.error(err); setTrafficRunning(false) }
  }

  const stopTest = async () => {
    setTrafficRunning(false)
    try { await axios.post(`${TRAFFIC_API}/api/traffic/stop-precision`, {}) } catch {}
    try { await axios.post('/api/capture/stop-c', {}) } catch {}
  }

  const cycleMs = tasData.cycleNs ? tasData.cycleNs / 1_000_000 : 1000
  const slotCount = tasData.gcl?.length || 8
  const maxGraphTime = (duration + 2) * 1000

  // GCL 예측 계산 (수신 패킷 분석 기반)
  const predictedGCL = useMemo(() => {
    if (!rxStats) return null

    // 8x8 매트릭스 생성 (slot x tc)
    const matrix = Array(8).fill(null).map(() => Array(8).fill(0))

    selectedTCs.forEach(tc => {
      const rx = rxStats.tc?.[tc] || rxStats.analysis?.[tc]
      if (!rx || !rx.count) return

      const avgMs = rx.avg_ms ?? (rx.avg_us / 1000)
      const count = rx.count

      // 평균 간격이 cycle time에 가까우면 gating 됨
      const isGated = tasData.enabled && avgMs && Math.abs(avgMs - cycleMs) < cycleMs * 0.3

      // 해당 TC의 슬롯 찾기
      if (tasData.gcl?.length) {
        for (let slot = 0; slot < tasData.gcl.length; slot++) {
          if ((tasData.gcl[slot].gates >> tc) & 1) {
            matrix[slot][tc] = { count, avgMs, isGated, active: true }
            break
          }
        }
      } else {
        // GCL 없으면 모든 슬롯 활성
        for (let slot = 0; slot < 8; slot++) {
          matrix[slot][tc] = { count: Math.round(count / 8), avgMs, isGated: false, active: true }
        }
      }
    })

    return matrix
  }, [rxStats, selectedTCs, tasData, cycleMs])

  const getSlot = (tc) => {
    if (!tasData.gcl?.length) return null
    for (let i = 0; i < tasData.gcl.length; i++) {
      if ((tasData.gcl[i].gates >> tc) & 1) return i
    }
    return null
  }

  const card = { background: '#fff', border: `1px solid ${colors.border}`, borderRadius: '6px', marginBottom: '16px' }
  const cardH = { padding: '12px 16px', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
  const cardB = { padding: '16px' }

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">TAS Dashboard</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {status && <span style={{ fontSize: '0.8rem', padding: '6px 12px', borderRadius: '4px', background: status.type === 'success' ? '#dcfce7' : status.type === 'error' ? '#fef2f2' : colors.bgAlt, color: status.type === 'success' ? colors.success : status.type === 'error' ? colors.error : colors.textMuted }}>{status.msg}</span>}
          <button className="btn btn-secondary" onClick={fetchTAS} disabled={loading}>{loading ? '...' : 'Refresh'}</button>
          <button className="btn btn-primary" onClick={configureTAS} disabled={!board}>Configure</button>
          <button className="btn btn-secondary" onClick={disableTAS} disabled={!board}>Disable</button>
        </div>
      </div>

      {/* Status Bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '10px', marginBottom: '16px' }}>
        {[
          { label: 'BOARD', value: board?.name?.split(' ')[0] || 'N/A' },
          { label: 'TAS', value: tasData.enabled ? 'ENABLED' : 'DISABLED', color: tasData.enabled ? colors.success : colors.textMuted },
          { label: 'CYCLE', value: `${cycleMs.toFixed(0)} ms` },
          { label: 'GUARD', value: `${tasData.guard || 0} ns` },
          { label: 'SLOTS', value: `${slotCount}` },
          { label: 'SLOT TIME', value: `${(cycleMs / slotCount).toFixed(1)} ms` },
        ].map((item, i) => (
          <div key={i} style={{ ...card, marginBottom: 0, padding: '12px' }}>
            <div style={{ fontSize: '0.65rem', color: colors.textMuted, marginBottom: '4px' }}>{item.label}</div>
            <div style={{ fontSize: '0.85rem', fontFamily: 'monospace', fontWeight: '600', color: item.color || colors.text }}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* TX/RX 래스터 그래프 (Y축: TC, X축: 시간) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        <TCRasterGraph
          data={txHistory}
          selectedTCs={selectedTCs}
          title="TX - Transmitted"
          color={colors.tx}
          maxTime={maxGraphTime}
          totalPackets={txHistory.reduce((sum, d) => sum + Object.values(d.tc).reduce((a, b) => a + b, 0), 0)}
        />
        <TCRasterGraph
          data={rxHistory}
          selectedTCs={selectedTCs}
          title="RX - Received (Shaped)"
          color={colors.rx}
          maxTime={maxGraphTime}
          totalPackets={rxHistory.reduce((sum, d) => sum + Object.values(d.tc).reduce((a, b) => a + b, 0), 0)}
        />
      </div>

      {/* GCL: 설정 vs 예측 (8x8 히트맵) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        {/* 설정된 GCL */}
        <div style={card}>
          <div style={cardH}>
            <span style={{ fontWeight: '600' }}>Configured GCL</span>
            <span style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: '4px', background: tasData.enabled ? '#dcfce7' : colors.bgAlt, color: tasData.enabled ? colors.success : colors.textMuted }}>
              {tasData.enabled ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </div>
          <div style={cardB}>
            <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(8, 1fr)', gap: '2px' }}>
              <div style={{ fontSize: '0.6rem', color: colors.textMuted }}></div>
              {[0,1,2,3,4,5,6,7].map(tc => (
                <div key={tc} style={{ textAlign: 'center', fontSize: '0.65rem', fontWeight: '600', color: tcColors[tc], padding: '4px 0' }}>TC{tc}</div>
              ))}
              {(tasData.gcl?.length ? tasData.gcl : Array(8).fill({ gates: 255, time: 125000000 })).map((entry, slot) => (
                <div key={slot} style={{ display: 'contents' }}>
                  <div style={{ fontSize: '0.6rem', color: colors.textMuted, display: 'flex', alignItems: 'center', fontFamily: 'monospace' }}>S{slot}</div>
                  {[0,1,2,3,4,5,6,7].map(tc => {
                    const open = (entry.gates >> tc) & 1
                    return (
                      <div key={tc} style={{
                        height: '24px', borderRadius: '2px',
                        background: open ? tcColors[tc] : colors.bgAlt,
                        opacity: open ? 0.85 : 1,
                        border: `1px solid ${open ? tcColors[tc] : colors.border}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.55rem', fontWeight: '600', color: open ? '#fff' : colors.textLight
                      }}>
                        {open ? 'O' : '-'}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
            <div style={{ marginTop: '8px', fontSize: '0.65rem', color: colors.textMuted, fontFamily: 'monospace' }}>
              Cycle: {cycleMs.toFixed(0)}ms | Guard: {tasData.guard || 0}ns
            </div>
          </div>
        </div>

        {/* 예측 GCL (8x8 히트맵) */}
        <div style={card}>
          <div style={cardH}>
            <span style={{ fontWeight: '600' }}>Predicted GCL (Analysis)</span>
            <span style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: '4px', background: rxStats?.final ? '#dcfce7' : colors.bgAlt, color: rxStats?.final ? colors.success : colors.textMuted }}>
              {rxStats?.final ? 'ANALYZED' : 'WAITING'}
            </span>
          </div>
          <div style={cardB}>
            {predictedGCL ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(8, 1fr)', gap: '2px' }}>
                  <div style={{ fontSize: '0.6rem', color: colors.textMuted }}></div>
                  {[0,1,2,3,4,5,6,7].map(tc => (
                    <div key={tc} style={{ textAlign: 'center', fontSize: '0.65rem', fontWeight: '600', color: tcColors[tc], padding: '4px 0' }}>TC{tc}</div>
                  ))}
                  {predictedGCL.map((row, slot) => (
                    <div key={slot} style={{ display: 'contents' }}>
                      <div style={{ fontSize: '0.6rem', color: colors.textMuted, display: 'flex', alignItems: 'center', fontFamily: 'monospace' }}>S{slot}</div>
                      {row.map((cell, tc) => {
                        const hasData = cell && cell.active
                        const isGated = cell?.isGated
                        return (
                          <div key={tc} style={{
                            height: '24px', borderRadius: '2px',
                            background: hasData ? (isGated ? colors.success : colors.warning) : colors.bgAlt,
                            opacity: hasData ? 0.85 : 1,
                            border: `1px solid ${hasData ? (isGated ? colors.success : colors.warning) : colors.border}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.5rem', fontWeight: '600', color: hasData ? '#fff' : colors.textLight
                          }} title={hasData ? `${cell.count} pkts, ${cell.avgMs?.toFixed(1)}ms` : ''}>
                            {hasData ? cell.count : '-'}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: '8px', fontSize: '0.65rem', color: colors.textMuted }}>
                  <span style={{ color: colors.success }}>■</span> GATED (interval ≈ cycle) &nbsp;
                  <span style={{ color: colors.warning }}>■</span> FREE (no gating)
                </div>
              </>
            ) : (
              <div style={{ padding: '40px', textAlign: 'center', color: colors.textLight }}>
                <div style={{ fontSize: '0.8rem', marginBottom: '4px' }}>No Data</div>
                <div style={{ fontSize: '0.65rem' }}>Run traffic test to analyze</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Traffic Test */}
      <div style={card}>
        <div style={cardH}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontWeight: '600' }}>Traffic Test</span>
            <span style={{ fontSize: '0.75rem', padding: '4px 8px', borderRadius: '4px', background: tapConnected ? '#dcfce7' : '#fef2f2', color: tapConnected ? colors.success : colors.error }}>
              {tapConnected ? 'Ready' : 'Disconnected'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {!trafficRunning ? (
              <button className="btn btn-primary" onClick={startTest} disabled={!trafficInterface || !tapConnected || selectedTCs.length === 0}>Start</button>
            ) : (
              <button className="btn" onClick={stopTest} style={{ background: '#fef2f2', color: colors.error, border: '1px solid #fecaca' }}>Stop</button>
            )}
            <button className="btn btn-secondary" onClick={() => { setRxStats(null); setTxHistory([]); setRxHistory([]) }}>Clear</button>
          </div>
        </div>
        <div style={cardB}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {[0,1,2,3,4,5,6,7].map(tc => (
              <button key={tc} onClick={() => !trafficRunning && setSelectedTCs(p => p.includes(tc) ? p.filter(t => t !== tc) : [...p, tc].sort())} disabled={trafficRunning}
                style={{ padding: '6px 12px', borderRadius: '4px', border: `2px solid ${selectedTCs.includes(tc) ? tcColors[tc] : colors.border}`, background: selectedTCs.includes(tc) ? `${tcColors[tc]}15` : '#fff', color: selectedTCs.includes(tc) ? tcColors[tc] : colors.textMuted, fontWeight: '600', fontSize: '0.75rem', cursor: trafficRunning ? 'not-allowed' : 'pointer' }}>
                TC{tc}
              </button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
            {[
              ['VLAN', vlanId, setVlanId],
              ['PPS/TC', pps, setPps],
              ['Duration', duration, setDuration],
              ['Total PPS', pps * selectedTCs.length, null],
            ].map(([label, val, setter]) => (
              <div key={label}>
                <div style={{ fontSize: '0.65rem', color: colors.textMuted, marginBottom: '4px' }}>{label}</div>
                {setter ? (
                  <input type="number" value={val} onChange={e => setter(+e.target.value || 0)} disabled={trafficRunning}
                    style={{ width: '100%', padding: '6px 8px', borderRadius: '4px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '0.8rem' }} />
                ) : (
                  <div style={{ padding: '6px 8px', background: colors.bgAlt, borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: '600' }}>{val}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Results Table */}
      {rxStats && (
        <div style={card}>
          <div style={cardH}>
            <span style={{ fontWeight: '600' }}>Analysis Results</span>
            <span style={{ fontSize: '0.75rem', padding: '4px 10px', borderRadius: '4px', background: rxStats.final ? '#dcfce7' : '#fef3c7', color: rxStats.final ? colors.success : colors.warning }}>
              {rxStats.final ? 'Complete' : `${(rxStats.elapsed_ms / 1000).toFixed(1)}s`}
            </span>
          </div>
          <div style={cardB}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
              <thead>
                <tr style={{ background: colors.bgAlt }}>
                  <th style={{ padding: '8px', textAlign: 'left' }}>TC</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>TX</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>RX</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>Avg Interval</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>Expected</th>
                  <th style={{ padding: '8px', textAlign: 'center' }}>Slot</th>
                  <th style={{ padding: '8px', textAlign: 'center' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {selectedTCs.map(tc => {
                  const rx = rxStats.tc?.[tc] || rxStats.analysis?.[tc]
                  const txTotal = txHistory.reduce((sum, d) => sum + (d.tc[tc] || 0), 0)
                  const rxCount = rx?.count || 0
                  const avgMs = rx ? (rx.avg_ms ?? rx.avg_us / 1000) : null
                  const slot = getSlot(tc)
                  const expectedMs = tasData.enabled && slot !== null ? cycleMs : null
                  const isGated = expectedMs && avgMs && Math.abs(avgMs - expectedMs) < expectedMs * 0.3

                  return (
                    <tr key={tc} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '8px', fontWeight: '600', color: tcColors[tc] }}>
                        <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: tcColors[tc], marginRight: '6px' }} />
                        TC{tc}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'monospace' }}>{txTotal || '-'}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>{rxCount || '-'}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'monospace' }}>{avgMs ? `${avgMs.toFixed(2)} ms` : '-'}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'monospace', color: colors.textMuted }}>{expectedMs ? `~${expectedMs.toFixed(0)} ms` : 'N/A'}</td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>
                        {slot !== null ? <span style={{ padding: '2px 6px', borderRadius: '3px', fontSize: '0.7rem', background: colors.bgAlt, fontFamily: 'monospace' }}>S{slot}</span> : '-'}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>
                        {rxCount > 0 ? (
                          <span style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '0.7rem', fontWeight: '600', background: isGated ? '#dcfce7' : '#fef3c7', color: isGated ? colors.success : colors.warning }}>
                            {isGated ? 'GATED' : 'FREE'}
                          </span>
                        ) : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {rxStats.final && (
              <div style={{ marginTop: '12px', padding: '10px', background: colors.bgAlt, borderRadius: '4px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', fontSize: '0.7rem' }}>
                <div><span style={{ color: colors.textMuted }}>Total TX:</span> <span style={{ fontFamily: 'monospace', fontWeight: '600' }}>{txHistory.reduce((sum, d) => sum + Object.values(d.tc).reduce((a, b) => a + b, 0), 0)}</span></div>
                <div><span style={{ color: colors.textMuted }}>Total RX:</span> <span style={{ fontFamily: 'monospace', fontWeight: '600' }}>{selectedTCs.reduce((sum, tc) => sum + ((rxStats.tc?.[tc] || rxStats.analysis?.[tc])?.count || 0), 0)}</span></div>
                <div><span style={{ color: colors.textMuted }}>TAS:</span> <span style={{ fontWeight: '600', color: tasData.enabled ? colors.success : colors.textMuted }}>{tasData.enabled ? 'Active' : 'Off'}</span></div>
                <div><span style={{ color: colors.textMuted }}>Duration:</span> <span style={{ fontFamily: 'monospace', fontWeight: '600' }}>{(rxStats.elapsed_ms / 1000).toFixed(1)}s</span></div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default TASDashboard
