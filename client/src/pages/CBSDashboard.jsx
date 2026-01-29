import { useState, useEffect, useRef, useMemo } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

const TAP_INTERFACE = 'enx00e04c6812d1'
const TRAFFIC_INTERFACE = 'enxc84d44263ba6'
const BOARD2_PORT8_MAC = '00:e0:4c:68:12:d1'
const TRAFFIC_API = 'http://localhost:3000'
const PACKET_SIZE_BYTES = 64
const PACKET_SIZE_BITS = PACKET_SIZE_BYTES * 8  // 512 bits
const LINK_SPEED_KBPS = 1000000  // 1Gbps = 1,000,000 kbps

// TC당 트래픽 속도(kbps)를 PPS로 변환
const kbpsToPps = (kbps) => Math.round((kbps * 1000) / PACKET_SIZE_BITS)
// PPS를 kbps로 변환
const ppsToKbps = (pps) => (pps * PACKET_SIZE_BITS) / 1000

const colors = {
  text: '#1f2937',
  textMuted: '#6b7280',
  border: '#e5e7eb',
  bgAlt: '#f3f4f6',
  success: '#059669',
  warning: '#d97706',
  error: '#dc2626',
}

const tcColors = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'
]

// Credit 시계열 그래프 컴포넌트
const CreditGraph = ({ creditHistory, selectedTCs, maxTime, idleSlopes }) => {
  const width = 900
  const height = 400
  const padding = { top: 40, right: 150, bottom: 50, left: 90 }
  const chartW = width - padding.left - padding.right
  const chartH = height - padding.top - padding.bottom

  const currentTime = creditHistory.length > 0 ? creditHistory[creditHistory.length - 1].time : 0

  // X축 범위
  const xMax = useMemo(() => {
    if (!creditHistory.length) return maxTime
    const lastTime = creditHistory[creditHistory.length - 1].time
    return Math.max(lastTime * 1.05, maxTime * 0.5, 1000)
  }, [creditHistory, maxTime])

  // Y축 범위 (credit 값)
  const { minCredit, maxCredit } = useMemo(() => {
    if (creditHistory.length < 2) return { minCredit: -2000, maxCredit: 2000 }
    let min = 0, max = 0
    creditHistory.forEach(entry => {
      selectedTCs.forEach(tc => {
        const val = entry.credit?.[tc] ?? 0
        if (val < min) min = val
        if (val > max) max = val
      })
    })
    const absMax = Math.max(Math.abs(min), Math.abs(max), 500)
    return { minCredit: -absMax * 1.2, maxCredit: absMax * 1.2 }
  }, [creditHistory, selectedTCs])

  const xScale = (time) => padding.left + (time / xMax) * chartW
  const yScale = (val) => {
    const range = maxCredit - minCredit
    if (range === 0) return padding.top + chartH / 2
    return padding.top + chartH - ((val - minCredit) / range) * chartH
  }

  // X축 틱
  const xTicks = useMemo(() => {
    const step = xMax > 10000 ? 2000 : xMax > 5000 ? 1000 : 500
    const ticks = []
    for (let i = 0; i <= xMax; i += step) ticks.push(i)
    return ticks
  }, [xMax])

  // Y축 틱
  const yTicks = useMemo(() => {
    const range = maxCredit - minCredit
    const step = range > 5000 ? 1000 : range > 2000 ? 500 : 200
    const ticks = []
    for (let v = Math.floor(minCredit / step) * step; v <= maxCredit; v += step) {
      ticks.push(v)
    }
    return ticks
  }, [minCredit, maxCredit])

  const zeroY = yScale(0)
  const zeroInRange = zeroY >= padding.top && zeroY <= padding.top + chartH

  return (
    <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '20px' }}>
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontWeight: '700', fontSize: '1rem', marginBottom: '8px' }}>TC별 Credit 변화 그래프</div>
        <div style={{ fontSize: '0.8rem', color: colors.textMuted }}>
          Y축: Credit (bits) | X축: 시간 (ms) |
          <span style={{ color: colors.error, fontWeight: '600' }}> 빨간 영역: Shaping 구간 (Credit {'<'} 0 → 전송 대기)</span>
        </div>
      </div>

      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
        {/* Shaping Zone 배경 (Credit < 0) */}
        {zeroInRange && (
          <rect x={padding.left} y={zeroY} width={chartW} height={padding.top + chartH - zeroY}
            fill={colors.error} opacity="0.15" />
        )}

        {/* Y축 그리드 */}
        {yTicks.map((tick, i) => (
          <g key={`y-${i}`}>
            <line x1={padding.left} y1={yScale(tick)} x2={padding.left + chartW} y2={yScale(tick)}
              stroke={tick === 0 ? '#000' : colors.border} strokeWidth={tick === 0 ? 2 : 0.5} />
            <text x={padding.left - 12} y={yScale(tick) + 4} textAnchor="end"
              fontSize="11" fill={colors.textMuted} fontFamily="monospace">
              {tick}
            </text>
          </g>
        ))}

        {/* X축 그리드 */}
        {xTicks.map((tick, i) => (
          <g key={`x-${i}`}>
            <line x1={xScale(tick)} y1={padding.top} x2={xScale(tick)} y2={padding.top + chartH}
              stroke={colors.border} strokeWidth="0.5" />
            <text x={xScale(tick)} y={padding.top + chartH + 20} textAnchor="middle"
              fontSize="11" fill={colors.textMuted}>{tick}ms</text>
          </g>
        ))}

        {/* Credit 라인 (TC별) */}
        {selectedTCs.map(tc => {
          if (creditHistory.length < 2) return null
          const points = creditHistory
            .filter(entry => entry.credit?.[tc] !== undefined)
            .map(entry => ({ x: xScale(entry.time), y: yScale(entry.credit[tc]) }))
          if (points.length < 2) return null
          const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

          return (
            <g key={tc}>
              <path d={pathD} fill="none" stroke={tcColors[tc]} strokeWidth="3" strokeLinecap="round" />
              {points.length > 0 && (
                <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y}
                  r="6" fill={tcColors[tc]} stroke="#fff" strokeWidth="2" />
              )}
            </g>
          )
        })}

        {/* 현재 시간 마커 */}
        {creditHistory.length > 1 && (
          <line x1={xScale(currentTime)} y1={padding.top} x2={xScale(currentTime)} y2={padding.top + chartH}
            stroke={colors.success} strokeWidth="2" strokeDasharray="6,4" />
        )}

        {/* 축 테두리 */}
        <rect x={padding.left} y={padding.top} width={chartW} height={chartH}
          fill="none" stroke={colors.text} strokeWidth="1" />

        {/* 축 라벨 */}
        <text x={30} y={height / 2} textAnchor="middle" fontSize="12" fill={colors.text} fontWeight="600"
          transform={`rotate(-90, 30, ${height / 2})`}>Credit (bits)</text>
        <text x={padding.left + chartW / 2} y={height - 10} textAnchor="middle" fontSize="12" fill={colors.text} fontWeight="600">
          시간 (ms)
        </text>

        {/* 0 라인 라벨 */}
        {zeroInRange && (
          <text x={padding.left + 8} y={zeroY - 8} fontSize="11" fill="#000" fontWeight="700">Credit = 0</text>
        )}

        {/* 범례 (오른쪽) */}
        <g transform={`translate(${width - padding.right + 20}, ${padding.top})`}>
          <text x="0" y="0" fontSize="11" fill={colors.text} fontWeight="600">TC 범례</text>
          {selectedTCs.map((tc, i) => (
            <g key={tc} transform={`translate(0, ${20 + i * 35})`}>
              <line x1="0" y1="8" x2="30" y2="8" stroke={tcColors[tc]} strokeWidth="3" />
              <circle cx="30" cy="8" r="5" fill={tcColors[tc]} />
              <text x="40" y="12" fontSize="11" fill={tcColors[tc]} fontWeight="700">TC{tc}</text>
              <text x="0" y="26" fontSize="9" fill={colors.textMuted}>
                {((idleSlopes[tc] || LINK_SPEED_KBPS) / 1000).toFixed(0)}Mbps
              </text>
            </g>
          ))}
        </g>
      </svg>

      {/* 현재 Credit 값 카드 */}
      {creditHistory.length > 0 && (
        <div style={{ display: 'flex', gap: '12px', marginTop: '16px', flexWrap: 'wrap' }}>
          {selectedTCs.map(tc => {
            const latest = creditHistory[creditHistory.length - 1]?.credit?.[tc] ?? 0
            const isShaping = latest < 0
            return (
              <div key={tc} style={{
                padding: '12px 16px', borderRadius: '8px', fontFamily: 'monospace',
                background: isShaping ? '#fef2f2' : '#f0fdf4',
                border: `3px solid ${tcColors[tc]}`,
                minWidth: '140px'
              }}>
                <div style={{ color: tcColors[tc], fontWeight: '700', fontSize: '1rem' }}>TC{tc}</div>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: isShaping ? colors.error : colors.text, marginTop: '4px' }}>
                  {Math.round(latest)} bits
                </div>
                <div style={{ fontSize: '0.75rem', marginTop: '4px', fontWeight: '600', color: isShaping ? colors.error : colors.success }}>
                  {isShaping ? 'SHAPING (대기중)' : 'OK (전송가능)'}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CBSDashboard() {
  const { devices } = useDevices()
  const [cbsData, setCbsData] = useState({})
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState(null)

  // Idle Slope 기본값 (kbps) - 낮은 값으로 설정해야 셰이핑 발생
  const [idleSlope, setIdleSlope] = useState({
    0: LINK_SPEED_KBPS,  // TC0: 무제한
    1: 500,    // TC1: 500kbps (0.5Mbps)
    2: 1000,   // TC2: 1Mbps
    3: 2000,   // TC3: 2Mbps
    4: 5000,   // TC4: 5Mbps
    5: 10000,  // TC5: 10Mbps
    6: 20000,  // TC6: 20Mbps
    7: 50000   // TC7: 50Mbps
  })

  const [trafficInterface, setTrafficInterface] = useState(null)
  const [trafficRunning, setTrafficRunning] = useState(false)
  const [selectedTCs, setSelectedTCs] = useState([1, 2, 3])  // 트래픽 전송할 TC
  const [monitorTCs, setMonitorTCs] = useState([1, 2, 3])    // Credit 모니터링할 TC
  const [vlanId, setVlanId] = useState(100)
  const [trafficRatePerTc, setTrafficRatePerTc] = useState(1000)  // TC당 트래픽 속도 (kbps) = 1Mbps
  const [duration, setDuration] = useState(5)
  const [cbsPort, setCbsPort] = useState(8)

  const [tapConnected, setTapConnected] = useState(false)
  const [captureStats, setCaptureStats] = useState(null)
  const [creditHistory, setCreditHistory] = useState([])
  const [startTime, setStartTime] = useState(null)
  const wsRef = useRef(null)
  const creditRef = useRef({})
  const simulationRef = useRef(null)
  const monitorTCsRef = useRef(monitorTCs)
  const idleSlopeRef = useRef(idleSlope)
  const trafficRateRef = useRef(trafficRatePerTc)

  // refs 업데이트
  useEffect(() => { monitorTCsRef.current = monitorTCs }, [monitorTCs])
  useEffect(() => { idleSlopeRef.current = idleSlope }, [idleSlope])
  useEffect(() => { trafficRateRef.current = trafficRatePerTc }, [trafficRatePerTc])

  const board1 = devices.find(d => d.name?.includes('#1') || d.device?.includes('ACM0'))
  const board2 = devices.find(d => d.name?.includes('#2') || d.device?.includes('ACM1'))
  const cbsBoard = board1 || board2

  const getQosPath = (port) => `/ietf-interfaces:interfaces/interface[name='${port}']/mchp-velocitysp-port:eth-qos/config`

  const fetchCBS = async () => {
    if (!cbsBoard) return
    setLoading(true)
    try {
      const res = await axios.post('/api/fetch', {
        paths: [`${getQosPath(cbsPort)}/traffic-class-shapers`],
        transport: cbsBoard.transport || 'serial',
        device: cbsBoard.device,
        host: cbsBoard.host,
        port: cbsBoard.port || 5683
      }, { timeout: 10000 })

      const shapers = []
      if (res.data?.result) {
        let current = null
        for (const line of res.data.result.split('\n')) {
          if (line.includes('traffic-class:')) {
            if (current) shapers.push(current)
            current = { tc: parseInt(line.split(':')[1]), idleSlope: 0 }
          } else if (line.includes('idle-slope:') && current) {
            current.idleSlope = parseInt(line.split(':')[1])
          }
        }
        if (current) shapers.push(current)
      }

      const newSlope = { ...idleSlope }
      shapers.forEach(s => { if (s.idleSlope > 0) newSlope[s.tc] = s.idleSlope })
      setIdleSlope(newSlope)
      setCbsData({ online: true, shapers })
    } catch {
      setCbsData({ online: false })
    }
    setLoading(false)
  }

  const applyCBS = async () => {
    if (!cbsBoard) return
    setStatus({ type: 'info', msg: `Port ${cbsPort}에 적용 중...` })
    try {
      const patches = []
      for (let tc = 0; tc < 8; tc++) {
        patches.push({
          path: `${getQosPath(cbsPort)}/traffic-class-shapers`,
          value: { 'traffic-class': tc, 'credit-based': { 'idle-slope': idleSlope[tc] || LINK_SPEED_KBPS } }
        })
      }
      await axios.post('/api/patch', { patches, transport: cbsBoard.transport, device: cbsBoard.device, host: cbsBoard.host }, { timeout: 30000 })
      setStatus({ type: 'success', msg: `Port ${cbsPort} CBS 적용 완료` })
      setTimeout(() => { fetchCBS(); setStatus(null) }, 1500)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

  const resetCBS = async () => {
    if (!cbsBoard) return
    setStatus({ type: 'info', msg: `Port ${cbsPort} 초기화 중...` })
    try {
      const patches = []
      for (let tc = 0; tc < 8; tc++) {
        patches.push({
          path: `${getQosPath(cbsPort)}/traffic-class-shapers`,
          value: { 'traffic-class': tc, 'credit-based': { 'idle-slope': LINK_SPEED_KBPS } }
        })
      }
      await axios.post('/api/patch', { patches, transport: cbsBoard.transport, device: cbsBoard.device, host: cbsBoard.host }, { timeout: 30000 })
      const resetSlope = {}
      for (let tc = 0; tc < 8; tc++) resetSlope[tc] = LINK_SPEED_KBPS
      setIdleSlope(resetSlope)
      setStatus({ type: 'success', msg: `Port ${cbsPort} 초기화 완료` })
      setTimeout(() => { fetchCBS(); setStatus(null) }, 1500)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
    }
  }

  useEffect(() => { if (cbsBoard) fetchCBS() }, [cbsBoard, cbsPort])
  useEffect(() => { setTrafficInterface(TRAFFIC_INTERFACE) }, [])
  useEffect(() => { return () => { if (simulationRef.current) clearInterval(simulationRef.current) } }, [])

  // startTime을 ref로 관리하여 WebSocket 재연결 방지
  const startTimeRef = useRef(null)
  useEffect(() => { startTimeRef.current = startTime }, [startTime])

  // WebSocket for capture data
  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/capture`)
      ws.onopen = () => setTapConnected(true)
      ws.onclose = () => { setTapConnected(false); setTimeout(connect, 3000) }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'c-capture-stats') {
            setCaptureStats(msg.data)
            // startTimeRef를 사용하여 최신 startTime 참조
            if (startTimeRef.current) {
              const elapsed = Date.now() - startTimeRef.current
              updateCredit(msg.data, elapsed)
            }
          } else if (msg.type === 'c-capture-stopped' && msg.stats?.analysis) {
            setCaptureStats(prev => ({ ...prev, final: true, analysis: msg.stats.analysis }))
          }
        } catch {}
      }
      wsRef.current = ws
    }
    connect()
    return () => wsRef.current?.close()
  }, [])  // 의존성 제거 - WebSocket은 한번만 연결

  // Credit 계산 함수 (실제 패킷 기반) - refs 사용하여 최신 값 참조
  const updateCredit = (stats, elapsed) => {
    const currentMonitorTCs = monitorTCsRef.current
    const currentIdleSlope = idleSlopeRef.current
    const newCredit = { ...creditRef.current }

    currentMonitorTCs.forEach(tc => {
      const slope = currentIdleSlope[tc] || LINK_SPEED_KBPS
      const currentCount = stats.tc?.[tc]?.count || 0
      const prevCredit = creditRef.current[tc] ?? 0

      // 이전 패킷 수 가져오기
      const prevPackets = creditRef.current[`packets_${tc}`] || 0
      const newPackets = Math.max(0, currentCount - prevPackets)

      // 시간 간격 계산
      const prevTime = creditRef.current.lastTime || 0
      const dt = Math.max(elapsed - prevTime, 1)

      // Credit 계산: idle 회복 - 전송 소비
      const idleRecoveryBits = (slope * dt) / 1000  // kbps * ms / 1000 = bits
      const txCostBits = newPackets * PACKET_SIZE_BITS * (1 - slope / LINK_SPEED_KBPS)

      let credit = prevCredit + idleRecoveryBits - txCostBits
      const hiCredit = PACKET_SIZE_BITS * 2
      const loCredit = -PACKET_SIZE_BITS * 10
      credit = Math.max(loCredit, Math.min(hiCredit, credit))

      newCredit[tc] = credit
      newCredit[`packets_${tc}`] = currentCount  // 패킷 수 저장
    })

    newCredit.lastTime = elapsed
    creditRef.current = newCredit

    setCreditHistory(prev => {
      const entry = { time: elapsed, credit: {}, packets: {} }
      currentMonitorTCs.forEach(tc => {
        entry.credit[tc] = newCredit[tc]
        entry.packets[tc] = stats.tc?.[tc]?.count || 0
      })
      return [...prev.slice(-200), entry]
    })
  }

  // Credit 시뮬레이션
  const simulateCredit = () => {
    if (simulationRef.current) clearInterval(simulationRef.current)
    setCreditHistory([])
    creditRef.current = {}
    monitorTCs.forEach(tc => { creditRef.current[tc] = 0 })

    const ppsPerTc = kbpsToPps(trafficRatePerTc)  // TC당 PPS
    const intervalMs = 20

    const initCredit = {}
    monitorTCs.forEach(tc => { initCredit[tc] = 0 })
    setCreditHistory([{ time: 0, credit: initCredit, packets: {} }])

    let simTime = 0

    simulationRef.current = setInterval(() => {
      simTime += intervalMs
      if (simTime > duration * 1000) {
        clearInterval(simulationRef.current)
        simulationRef.current = null
        return
      }

      const newCredit = {}
      monitorTCs.forEach(tc => {
        const slope = idleSlope[tc] || LINK_SPEED_KBPS
        const prevCredit = creditRef.current[tc] ?? 0
        const isTrafficTC = selectedTCs.includes(tc)
        const packetsInInterval = isTrafficTC ? (ppsPerTc * intervalMs) / 1000 : 0

        // Credit 계산
        const idleRecoveryBits = (slope * intervalMs) / 1000  // bits
        const txCostBits = packetsInInterval * PACKET_SIZE_BITS * (1 - slope / LINK_SPEED_KBPS)

        let credit = prevCredit + idleRecoveryBits - txCostBits
        const hiCredit = PACKET_SIZE_BITS * 2
        const loCredit = -PACKET_SIZE_BITS * 10
        credit = Math.max(loCredit, Math.min(hiCredit, credit))
        newCredit[tc] = credit
        creditRef.current[tc] = credit
      })

      setCreditHistory(prev => [...prev.slice(-300), { time: simTime, credit: { ...newCredit }, packets: {} }])
    }, intervalMs)
  }

  const stopSimulation = () => {
    if (simulationRef.current) { clearInterval(simulationRef.current); simulationRef.current = null }
  }

  const startTest = async () => {
    if (!trafficInterface || selectedTCs.length === 0) return
    stopSimulation()
    setCaptureStats(null)
    setCreditHistory([])
    creditRef.current = {}
    monitorTCs.forEach(tc => { creditRef.current[tc] = 0 })

    const initCredit = {}
    monitorTCs.forEach(tc => { initCredit[tc] = 0 })
    setCreditHistory([{ time: 0, credit: initCredit, packets: {} }])

    // 총 PPS 계산: TC당 PPS * TC 개수
    const totalPps = trafficInfo.totalPps

    try {
      await axios.post('/api/capture/start-c', { interface: TAP_INTERFACE, duration: duration + 2, vlanId })
      await new Promise(r => setTimeout(r, 300))
      setTrafficRunning(true)
      setStartTime(Date.now())  // 트래픽 시작 직전에 시간 설정
      await axios.post(`${TRAFFIC_API}/api/traffic/start-precision`, {
        interface: trafficInterface, dstMac: BOARD2_PORT8_MAC, vlanId, tcList: selectedTCs, packetsPerSecond: totalPps, duration
      })
      setTimeout(stopTest, (duration + 3) * 1000)
    } catch (err) {
      console.error(err)
      setTrafficRunning(false)
    }
  }

  const stopTest = async () => {
    setTrafficRunning(false)
    stopSimulation()
    try { await axios.post(`${TRAFFIC_API}/api/traffic/stop-precision`, {}) } catch {}
    try { await axios.post('/api/capture/stop-c', {}) } catch {}
  }

  // TC별 예상 트래픽 계산
  const trafficInfo = useMemo(() => {
    const ppsPerTc = kbpsToPps(trafficRatePerTc)  // TC당 PPS
    const totalPps = ppsPerTc * selectedTCs.length  // 총 PPS

    const result = {}
    for (let tc = 0; tc < 8; tc++) {
      const slope = idleSlope[tc] || LINK_SPEED_KBPS
      const isLimited = slope < LINK_SPEED_KBPS
      const isTraffic = selectedTCs.includes(tc)
      const trafficKbps = isTraffic ? trafficRatePerTc : 0
      const willShape = isLimited && trafficKbps > slope

      result[tc] = { slope, isLimited, trafficKbps, willShape, ppsPerTc: isTraffic ? ppsPerTc : 0 }
    }
    result.totalPps = totalPps
    result.ppsPerTc = ppsPerTc
    return result
  }, [idleSlope, trafficRatePerTc, selectedTCs])

  const formatBw = (kbps) => {
    if (kbps >= 1000000) return `${(kbps / 1000000).toFixed(1)}Gbps`
    if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)}Mbps`
    return `${Math.round(kbps)}kbps`
  }

  const maxGraphTime = (duration + 1) * 1000
  const card = { background: '#fff', border: `1px solid ${colors.border}`, borderRadius: '8px', marginBottom: '16px' }
  const cardHeader = { padding: '14px 18px', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
  const cardBody = { padding: '18px' }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">CBS Dashboard</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {status && <span style={{ fontSize: '0.85rem', padding: '8px 14px', borderRadius: '6px', background: status.type === 'success' ? '#dcfce7' : status.type === 'error' ? '#fef2f2' : colors.bgAlt, color: status.type === 'success' ? colors.success : status.type === 'error' ? colors.error : colors.textMuted }}>{status.msg}</span>}
          <button className="btn btn-secondary" onClick={fetchCBS} disabled={loading}>{loading ? '...' : 'Refresh'}</button>
          <button className="btn btn-primary" onClick={applyCBS} disabled={!cbsBoard}>Apply</button>
          <button className="btn btn-secondary" onClick={resetCBS} disabled={!cbsBoard}>Reset All</button>
        </div>
      </div>

      {/* 연결 정보 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '16px' }}>
        {[
          { label: 'Board', value: cbsBoard?.name || 'Not Connected', sub: cbsBoard?.device || '-' },
          { label: 'CBS Port', isSelect: true },
          { label: 'TX Interface', value: trafficInterface || 'Not Found' },
          { label: 'RX Interface', value: TAP_INTERFACE, sub: tapConnected ? 'Ready' : 'Disconnected', ok: tapConnected }
        ].map((item, i) => (
          <div key={i} style={{ ...card, marginBottom: 0 }}>
            <div style={cardBody}>
              <div style={{ fontSize: '0.8rem', color: colors.textMuted, fontWeight: '600', marginBottom: '6px' }}>{item.label}</div>
              {item.isSelect ? (
                <select value={cbsPort} onChange={e => setCbsPort(parseInt(e.target.value))}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '0.9rem' }}>
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map(p => <option key={p} value={p}>Port {p}</option>)}
                </select>
              ) : (
                <>
                  <div style={{ fontSize: '0.95rem', fontFamily: 'monospace', fontWeight: '600' }}>{item.value}</div>
                  {item.sub && <div style={{ fontSize: '0.8rem', color: item.ok === false ? colors.error : item.ok ? colors.success : colors.textMuted, marginTop: '4px' }}>{item.sub}</div>}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Idle Slope 설정 테이블 */}
      <div style={card}>
        <div style={cardHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontWeight: '700', fontSize: '1rem' }}>Idle Slope 설정 (TC별 대역폭 제한)</span>
            <span style={{ fontSize: '0.8rem', padding: '4px 12px', borderRadius: '6px', background: cbsData.online ? '#dcfce7' : colors.bgAlt, color: cbsData.online ? colors.success : colors.textMuted }}>
              {cbsData.online ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>
        </div>
        <div style={cardBody}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: colors.bgAlt }}>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600' }}>TC</th>
                <th style={{ padding: '12px', width: '150px', fontWeight: '600' }}>Idle Slope (kbps)</th>
                <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>대역폭</th>
                <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>트래픽 속도</th>
                <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>상태</th>
              </tr>
            </thead>
            <tbody>
              {[0,1,2,3,4,5,6,7].map(tc => {
                const info = trafficInfo[tc]
                return (
                  <tr key={tc} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td style={{ padding: '12px' }}>
                      <span style={{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '3px', background: tcColors[tc], marginRight: '8px' }}></span>
                      <span style={{ fontWeight: '700' }}>TC{tc}</span>
                    </td>
                    <td style={{ padding: '12px' }}>
                      <input type="number" value={idleSlope[tc] || ''} onChange={e => setIdleSlope(prev => ({ ...prev, [tc]: parseInt(e.target.value) || 0 }))}
                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', textAlign: 'right', fontSize: '0.9rem' }} />
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center', fontFamily: 'monospace', fontWeight: '600' }}>
                      {formatBw(info.slope)}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center', fontFamily: 'monospace' }}>
                      {info.trafficKbps > 0 ? formatBw(info.trafficKbps) : '-'}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      {info.trafficKbps > 0 ? (
                        <span style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '0.8rem', fontWeight: '700',
                          background: info.willShape ? '#fef2f2' : '#dcfce7',
                          color: info.willShape ? colors.error : colors.success }}>
                          {info.willShape ? 'SHAPING 예상' : 'OK'}
                        </span>
                      ) : (
                        <span style={{ color: colors.textMuted }}>-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 트래픽 테스트 설정 */}
      <div style={card}>
        <div style={cardHeader}>
          <span style={{ fontWeight: '700', fontSize: '1rem' }}>트래픽 테스트</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            {!trafficRunning ? (
              <button className="btn btn-primary" onClick={startTest} disabled={!trafficInterface || !tapConnected || selectedTCs.length === 0}>실제 테스트</button>
            ) : (
              <button className="btn" onClick={stopTest} style={{ background: '#fef2f2', color: colors.error, border: '1px solid #fecaca' }}>Stop</button>
            )}
            <button className="btn btn-secondary" onClick={simulateCredit} disabled={monitorTCs.length === 0 || trafficRunning}>시뮬레이션</button>
            <button className="btn btn-secondary" onClick={() => { stopSimulation(); setCreditHistory([]); setCaptureStats(null) }}>Clear</button>
          </div>
        </div>
        <div style={cardBody}>
          {/* 트래픽 TC 선택 */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '8px' }}>트래픽 전송 TC 선택</div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {[0,1,2,3,4,5,6,7].map(tc => (
                <button key={tc} onClick={() => !trafficRunning && setSelectedTCs(prev => prev.includes(tc) ? prev.filter(t => t !== tc) : [...prev, tc].sort())} disabled={trafficRunning}
                  style={{ padding: '10px 18px', borderRadius: '6px', border: `3px solid ${selectedTCs.includes(tc) ? tcColors[tc] : colors.border}`, background: selectedTCs.includes(tc) ? `${tcColors[tc]}20` : '#fff', color: selectedTCs.includes(tc) ? tcColors[tc] : colors.textMuted, fontWeight: '700', cursor: trafficRunning ? 'not-allowed' : 'pointer' }}>
                  TC{tc}
                </button>
              ))}
            </div>
          </div>

          {/* Credit 모니터링 TC 선택 */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '8px' }}>Credit 모니터링 TC 선택</div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {[0,1,2,3,4,5,6,7].map(tc => (
                <button key={tc} onClick={() => setMonitorTCs(prev => prev.includes(tc) ? prev.filter(t => t !== tc) : [...prev, tc].sort())}
                  style={{ padding: '10px 18px', borderRadius: '6px', border: `3px solid ${monitorTCs.includes(tc) ? tcColors[tc] : colors.border}`, background: monitorTCs.includes(tc) ? `${tcColors[tc]}20` : '#fff', color: monitorTCs.includes(tc) ? tcColors[tc] : colors.textMuted, fontWeight: '700', cursor: 'pointer' }}>
                  TC{tc}
                </button>
              ))}
            </div>
          </div>

          {/* 파라미터 입력 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '16px' }}>
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '6px' }}>VLAN ID</div>
              <input type="number" value={vlanId} onChange={e => setVlanId(parseInt(e.target.value) || 0)} disabled={trafficRunning}
                style={{ width: '100%', padding: '10px', borderRadius: '6px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '1rem' }} />
            </div>
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '6px' }}>TC당 트래픽 속도 (kbps)</div>
              <input type="number" value={trafficRatePerTc} onChange={e => setTrafficRatePerTc(parseInt(e.target.value) || 0)} disabled={trafficRunning}
                style={{ width: '100%', padding: '10px', borderRadius: '6px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '1rem' }} />
              <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginTop: '4px' }}>
                = {formatBw(trafficRatePerTc)} / TC
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '6px' }}>Duration (초)</div>
              <input type="number" value={duration} onChange={e => setDuration(parseInt(e.target.value) || 0)} disabled={trafficRunning}
                style={{ width: '100%', padding: '10px', borderRadius: '6px', border: `1px solid ${colors.border}`, fontFamily: 'monospace', fontSize: '1rem' }} />
            </div>
          </div>

          {/* 트래픽 계산 결과 */}
          {selectedTCs.length > 0 && (
            <div style={{ padding: '14px', background: colors.bgAlt, borderRadius: '8px', marginBottom: '16px' }}>
              <div style={{ fontWeight: '700', marginBottom: '8px' }}>트래픽 설정 요약</div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.9rem', lineHeight: '1.8' }}>
                <div>TC당 트래픽: <strong>{formatBw(trafficRatePerTc)}</strong></div>
                <div>선택된 TC: <strong>{selectedTCs.length}</strong>개 (TC{selectedTCs.join(', TC')})</div>
                <div>총 트래픽: <strong>{formatBw(trafficRatePerTc * selectedTCs.length)}</strong></div>
                <div style={{ marginTop: '8px', color: colors.textMuted }}>
                  TC당 {trafficInfo.ppsPerTc} pps × {selectedTCs.length} TC = 총 {trafficInfo.totalPps} pps
                </div>
                <div style={{ color: colors.textMuted }}>패킷 크기: {PACKET_SIZE_BYTES} bytes</div>
              </div>
            </div>
          )}

          {/* Credit Graph */}
          {monitorTCs.length > 0 && (
            <CreditGraph
              creditHistory={creditHistory}
              selectedTCs={monitorTCs}
              maxTime={maxGraphTime}
              idleSlopes={idleSlope}
            />
          )}
        </div>
      </div>

      {/* 패킷 모니터 결과 */}
      {captureStats && (
        <div style={card}>
          <div style={cardHeader}>
            <span style={{ fontWeight: '700', fontSize: '1rem' }}>패킷 캡처 결과</span>
            <span style={{ fontSize: '0.85rem', padding: '6px 14px', borderRadius: '6px', background: captureStats.final ? '#dcfce7' : '#fef3c7', color: captureStats.final ? colors.success : colors.warning, fontWeight: '600' }}>
              {captureStats.final ? '완료' : `${(captureStats.elapsed_ms / 1000).toFixed(1)}s`}
            </span>
          </div>
          <div style={cardBody}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: colors.bgAlt }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600' }}>TC</th>
                  <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>패킷 수</th>
                  <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>실제 속도</th>
                  <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>전송 속도</th>
                  <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Idle Slope</th>
                  <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>결과</th>
                </tr>
              </thead>
              <tbody>
                {selectedTCs.map(tc => {
                  const stats = captureStats.tc?.[tc] || captureStats.analysis?.[tc]
                  const info = trafficInfo[tc]
                  const actualKbps = stats?.kbps || 0
                  // Shaping 판정: 실제 속도가 전송 속도의 80% 미만이면 shaped
                  const wasShaped = actualKbps > 0 && actualKbps < info.trafficKbps * 0.8
                  // 또는 idle slope 이하로 제한되었으면 shaped
                  const limitedBySlope = info.willShape && actualKbps > 0 && actualKbps <= info.slope * 1.1

                  return (
                    <tr key={tc} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '12px' }}>
                        <span style={{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '3px', background: tcColors[tc], marginRight: '8px' }}></span>
                        <span style={{ fontWeight: '700' }}>TC{tc}</span>
                      </td>
                      <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>{stats?.count || '-'}</td>
                      <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>{actualKbps ? formatBw(actualKbps) : '-'}</td>
                      <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: colors.textMuted }}>{formatBw(info.trafficKbps)}</td>
                      <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: info.willShape ? colors.error : colors.textMuted }}>{formatBw(info.slope)}</td>
                      <td style={{ padding: '12px', textAlign: 'center' }}>
                        {stats?.count ? (
                          <span style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '0.8rem', fontWeight: '700',
                            background: wasShaped || limitedBySlope ? '#fef2f2' : '#dcfce7',
                            color: wasShaped || limitedBySlope ? colors.error : colors.success }}>
                            {wasShaped || limitedBySlope ? 'SHAPED' : 'OK'}
                          </span>
                        ) : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default CBSDashboard
