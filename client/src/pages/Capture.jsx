import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import axios from 'axios'
import { useCapture } from '../contexts/CaptureContext'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'

const MAX_PACKETS = 500
const UPDATE_INTERVAL = 200

function Capture() {
  const {
    capturing, status, error, wsConnected, activeInterfaces,
    startCapture, stopCapture, addPacketListener, setError
  } = useCapture()

  const [packets, setPackets] = useState([])
  const [selectedPacket, setSelectedPacket] = useState(null)
  const [interfaces, setInterfaces] = useState([])
  const [selectedInterfaces, setSelectedInterfaces] = useState([])
  const [filterHost, setFilterHost] = useState('')
  const [filterPort, setFilterPort] = useState('5683')
  const [captureMode, setCaptureMode] = useState('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const [protocolFilter, setProtocolFilter] = useState('all')
  const [paused, setPaused] = useState(false)
  const [showPtpAnalysis, setShowPtpAnalysis] = useState(false)

  // PTP Analysis state
  const [ptpAnalysis, setPtpAnalysis] = useState({
    syncPairs: [], // [{syncTime, followUpTime, sequenceId, correctionField, offset}]
    pdelayPairs: [],
    offsetHistory: []
  })

  const tableRef = useRef(null)
  const packetBufferRef = useRef([])
  const updateTimerRef = useRef(null)
  const pausedRef = useRef(false)
  const ptpStateRef = useRef({
    lastSync: null,
    lastPdelayReq: null,
    lastPdelayResp: null
  })

  // Keep pausedRef in sync
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  // Flush packet buffer to state
  const flushBuffer = useCallback(() => {
    if (pausedRef.current) return
    if (packetBufferRef.current.length === 0) return

    const newPackets = packetBufferRef.current
    packetBufferRef.current = []

    setPackets(prev => {
      const combined = [...prev, ...newPackets]
      return combined.length > MAX_PACKETS ? combined.slice(-MAX_PACKETS) : combined
    })
  }, [])

  // PTP packet analysis - wrapped in try-catch for safety
  const analyzePtpPacket = useCallback((packet) => {
    try {
      if (!packet || packet.protocol !== 'PTP' || !packet.ptp) return

      const ptp = packet.ptp
      const state = ptpStateRef.current
      if (!state) return

      const timestamp = Date.now()

      switch (ptp.msgType) {
        case 'Sync':
          state.lastSync = {
            sequenceId: ptp.sequenceId,
            ts: timestamp,
            clockId: ptp.clockId
          }
          break

        case 'Follow_Up':
          if (state.lastSync && state.lastSync.ts && state.lastSync.sequenceId === ptp.sequenceId) {
            const correctionNs = ptp.correction || 0
            const syncTs = state.lastSync.ts

            setPtpAnalysis(prev => {
              const newPair = {
                sequenceId: ptp.sequenceId,
                syncTime: syncTs,
                followUpTime: timestamp,
                correctionField: correctionNs,
                time: new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
              }

              return {
                ...prev,
                syncPairs: [...prev.syncPairs, newPair].slice(-100),
                offsetHistory: [...prev.offsetHistory, { time: newPair.time, correction: correctionNs }].slice(-60)
              }
            })

            state.lastSync = null
          }
          break

        case 'Pdelay_Req':
          state.lastPdelayReq = {
            sequenceId: ptp.sequenceId,
            ts: timestamp
          }
          break

        case 'Pdelay_Resp':
          if (state.lastPdelayReq && state.lastPdelayReq.ts && state.lastPdelayReq.sequenceId === ptp.sequenceId) {
            const rtt = timestamp - state.lastPdelayReq.ts
            setPtpAnalysis(prev => ({
              ...prev,
              pdelayPairs: [...prev.pdelayPairs, {
                sequenceId: ptp.sequenceId,
                rtt
              }].slice(-50)
            }))
          }
          break

        default:
          break
      }
    } catch (e) {
      // Silently ignore PTP analysis errors
    }
  }, [])

  // Handle incoming packet
  const handlePacket = useCallback((packet) => {
    packetBufferRef.current.push(packet)
    analyzePtpPacket(packet)
  }, [analyzePtpPacket])

  // Register packet listener
  useEffect(() => {
    const unsubscribe = addPacketListener(handlePacket)

    // Start update timer
    updateTimerRef.current = setInterval(flushBuffer, UPDATE_INTERVAL)

    return () => {
      unsubscribe()
      if (updateTimerRef.current) {
        clearInterval(updateTimerRef.current)
      }
    }
  }, [addPacketListener, handlePacket, flushBuffer])

  // Load interfaces
  useEffect(() => {
    loadInterfaces()
  }, [])

  // Sync selected interfaces with active
  useEffect(() => {
    if (capturing && activeInterfaces.length > 0) {
      setSelectedInterfaces(activeInterfaces)
    }
  }, [capturing, activeInterfaces])

  // Auto scroll
  useEffect(() => {
    if (autoScroll && !paused && tableRef.current) {
      tableRef.current.scrollTop = tableRef.current.scrollHeight
    }
  }, [packets, autoScroll, paused])

  const loadInterfaces = async () => {
    try {
      const res = await axios.get('/api/capture/interfaces')
      const sorted = res.data
        .filter(i => i.name !== 'ap')
        .sort((a, b) => {
          const aEsp = a.name.startsWith('esp')
          const bEsp = b.name.startsWith('esp')
          if (aEsp && !bEsp) return -1
          if (!aEsp && bEsp) return 1
          return a.name.localeCompare(b.name)
        })
      setInterfaces(sorted)
    } catch (err) {
      setError('Failed to load interfaces')
    }
  }

  const toggleInterface = (name) => {
    setSelectedInterfaces(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )
  }

  const handleStart = () => {
    setPackets([])
    packetBufferRef.current = []
    setPtpAnalysis({ syncPairs: [], pdelayPairs: [], offsetHistory: [] })
    ptpStateRef.current = { lastSync: null, lastPdelayReq: null, lastPdelayResp: null }
    startCapture({
      interfaces: selectedInterfaces,
      port: parseInt(filterPort) || 5683,
      host: filterHost || '',
      captureMode
    })
  }

  const handleClear = () => {
    setPackets([])
    packetBufferRef.current = []
    setSelectedPacket(null)
    setPtpAnalysis({ syncPairs: [], pdelayPairs: [], offsetHistory: [] })
    ptpStateRef.current = { lastSync: null, lastPdelayReq: null, lastPdelayResp: null }
  }

  const formatTime = (isoTime) => {
    const date = new Date(isoTime)
    return date.toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
    })
  }

  const getProtocolColor = (protocol) => {
    const colors = {
      'CoAP': '#4ade80', 'PTP': '#a78bfa', 'TCP': '#f97316',
      'ICMP': '#06b6d4', 'UDP': '#60a5fa'
    }
    return colors[protocol] || '#94a3b8'
  }

  const getCodeColor = (code) => {
    if (!code) return '#94a3b8'
    if (code.startsWith('2.')) return '#4ade80'
    if (code.startsWith('4.') || code.startsWith('5.')) return '#f87171'
    return '#fbbf24'
  }

  const formatHexDump = (hexStr, asciiStr) => {
    if (!hexStr) return []
    const bytes = hexStr.split(' ')
    const lines = []
    for (let i = 0; i < bytes.length; i += 16) {
      lines.push({
        offset: i.toString(16).padStart(4, '0'),
        hex: bytes.slice(i, i + 16).join(' ').padEnd(47, ' '),
        ascii: asciiStr ? asciiStr.slice(i, i + 16) : ''
      })
    }
    return lines
  }

  const filteredPackets = useMemo(() => {
    if (protocolFilter === 'all') return packets
    return packets.filter(p => p.protocol === protocolFilter)
  }, [packets, protocolFilter])

  const stats = useMemo(() => ({
    total: packets.length,
    coap: packets.filter(p => p.protocol === 'CoAP').length,
    ptp: packets.filter(p => p.protocol === 'PTP').length,
    tcp: packets.filter(p => p.protocol === 'TCP').length,
    udp: packets.filter(p => p.protocol === 'UDP').length
  }), [packets])

  // PTP stats
  const ptpStats = useMemo(() => {
    const ptpPackets = packets.filter(p => p.protocol === 'PTP')
    const msgTypes = {}
    ptpPackets.forEach(p => {
      const type = p.ptp?.msgType || 'Unknown'
      msgTypes[type] = (msgTypes[type] || 0) + 1
    })
    return { total: ptpPackets.length, msgTypes }
  }, [packets])

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Packet Capture</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className={`btn ${showPtpAnalysis ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowPtpAnalysis(!showPtpAnalysis)}
            style={{ fontSize: '0.8rem' }}
          >
            PTP Analysis
          </button>
        </div>
      </div>

      {/* PTP Analysis Panel */}
      {showPtpAnalysis && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div className="card-header">
            <h2 className="card-title">PTP Analysis</h2>
            <div style={{ display: 'flex', gap: '16px', fontSize: '0.75rem' }}>
              {Object.entries(ptpStats.msgTypes).map(([type, count]) => (
                <span key={type} style={{ color: '#a78bfa' }}>
                  {type}: <b>{count}</b>
                </span>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            {/* Sync/Follow_Up Pairs */}
            <div>
              <h3 style={{ fontSize: '0.85rem', marginBottom: '8px', color: '#64748b' }}>
                Sync/Follow_Up Pairs ({ptpAnalysis.syncPairs.length})
              </h3>
              <div style={{
                maxHeight: '150px', overflow: 'auto',
                fontSize: '0.7rem', fontFamily: 'monospace',
                background: '#f8fafc', borderRadius: '6px', padding: '8px'
              }}>
                {ptpAnalysis.syncPairs.length === 0 ? (
                  <div style={{ color: '#94a3b8', textAlign: 'center', padding: '20px' }}>
                    Waiting for Sync/Follow_Up packets...
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <th style={{ textAlign: 'left', padding: '4px' }}>SeqID</th>
                        <th style={{ textAlign: 'left', padding: '4px' }}>Time</th>
                        <th style={{ textAlign: 'right', padding: '4px' }}>Correction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ptpAnalysis.syncPairs.slice(-20).reverse().map((pair, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '4px' }}>{pair.sequenceId}</td>
                          <td style={{ padding: '4px' }}>{pair.time}</td>
                          <td style={{ padding: '4px', textAlign: 'right', color: '#6366f1' }}>
                            {pair.correctionField} ns
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Correction Field Graph */}
            <div>
              <h3 style={{ fontSize: '0.85rem', marginBottom: '8px', color: '#64748b' }}>
                Correction Field History
              </h3>
              <div style={{ height: '150px' }}>
                {ptpAnalysis.offsetHistory.length > 1 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={ptpAnalysis.offsetHistory} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="time" tick={{ fontSize: 9 }} stroke="#94a3b8" interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 9 }} stroke="#94a3b8" />
                      <Tooltip contentStyle={{ fontSize: '0.7rem' }} formatter={(v) => [`${v} ns`, 'Correction']} />
                      <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                      <Line
                        type="monotone"
                        dataKey="correction"
                        stroke="#a78bfa"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{
                    height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: '#f8fafc', borderRadius: '6px', color: '#94a3b8', fontSize: '0.8rem'
                  }}>
                    Waiting for data...
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Pdelay Info */}
          {ptpAnalysis.pdelayPairs.length > 0 && (
            <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e2e8f0' }}>
              <h3 style={{ fontSize: '0.85rem', marginBottom: '8px', color: '#64748b' }}>
                Pdelay RTT (last 10)
              </h3>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {ptpAnalysis.pdelayPairs.slice(-10).map((p, i) => (
                  <span key={i} style={{
                    padding: '4px 8px', background: '#f0fdf4', borderRadius: '4px',
                    fontSize: '0.7rem', fontFamily: 'monospace'
                  }}>
                    #{p.sequenceId}: {p.rtt}ms
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Capture</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{
              padding: '4px 8px', borderRadius: '12px', fontSize: '0.7rem', fontWeight: '500',
              background: wsConnected ? '#ecfdf5' : '#fef2f2',
              color: wsConnected ? '#059669' : '#b91c1c'
            }}>
              <span style={{
                display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%',
                background: wsConnected ? '#059669' : '#dc2626', marginRight: '4px'
              }}></span>
              WS
            </span>

            {capturing && (
              <span style={{
                padding: '4px 10px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '500',
                background: paused ? '#fefce8' : '#ecfdf5',
                color: paused ? '#a16207' : '#059669'
              }}>
                {paused ? 'Paused' : 'Capturing'}
              </span>
            )}

            {!capturing ? (
              <button className="btn btn-primary" onClick={handleStart}
                disabled={selectedInterfaces.length === 0 || !wsConnected}>
                Start
              </button>
            ) : (
              <>
                <button className="btn btn-secondary" onClick={() => setPaused(p => !p)}>
                  {paused ? 'Resume' : 'Pause'}
                </button>
                <button className="btn btn-danger" onClick={stopCapture}>Stop</button>
              </>
            )}
            <button className="btn btn-secondary" onClick={handleClear}>Clear</button>
          </div>
        </div>

        {/* Interfaces */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {interfaces.map(iface => (
              <label key={iface.name} style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem',
                background: selectedInterfaces.includes(iface.name) ? '#f1f5f9' : '#f8fafc',
                border: selectedInterfaces.includes(iface.name) ? '2px solid #475569' : '2px solid transparent'
              }}>
                <input type="checkbox"
                  checked={selectedInterfaces.includes(iface.name)}
                  onChange={() => toggleInterface(iface.name)}
                  disabled={capturing || (!selectedInterfaces.includes(iface.name) && selectedInterfaces.length >= 4)}
                />
                <span style={{ fontWeight: '500' }}>{iface.name}</span>
                <span style={{ fontSize: '0.7rem', color: '#64748b', fontFamily: 'monospace' }}>
                  {iface.addresses?.[0] || ''}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Mode</label>
            <select className="form-select" value={captureMode}
              onChange={(e) => setCaptureMode(e.target.value)} disabled={capturing}>
              <option value="all">All</option>
              <option value="coap">CoAP</option>
              <option value="ptp">PTP</option>
            </select>
          </div>
          {captureMode === 'coap' && (
            <div className="form-group">
              <label className="form-label">Port</label>
              <input type="text" className="form-input" value={filterPort}
                onChange={(e) => setFilterPort(e.target.value)} disabled={capturing} style={{ width: '70px' }} />
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Filter</label>
            <select className="form-select" value={protocolFilter} onChange={(e) => setProtocolFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="CoAP">CoAP</option>
              <option value="PTP">PTP</option>
              <option value="TCP">TCP</option>
              <option value="UDP">UDP</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
              Auto-scroll
            </label>
          </div>
        </div>

        {/* Stats bar */}
        <div style={{ display: 'flex', gap: '16px', padding: '8px 0', fontSize: '0.8rem', color: '#64748b' }}>
          <span>Total: <b>{stats.total}</b></span>
          <span style={{ color: '#166534' }}>CoAP: <b>{stats.coap}</b></span>
          <span style={{ color: '#6d28d9' }}>PTP: <b>{stats.ptp}</b></span>
          <span style={{ color: '#c2410c' }}>TCP: <b>{stats.tcp}</b></span>
          <span style={{ color: '#1e40af' }}>UDP: <b>{stats.udp}</b></span>
          {filteredPackets.length !== packets.length && (
            <span>Showing: <b>{filteredPackets.length}</b></span>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Packet Table */}
      <div className="card" style={{ padding: 0 }}>
        <div ref={tableRef} style={{ height: '400px', overflow: 'auto', fontSize: '0.75rem', fontFamily: 'monospace' }}>
          <table className="table" style={{ marginBottom: 0 }}>
            <thead style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 1 }}>
              <tr>
                <th style={{ width: '50px' }}>No</th>
                <th style={{ width: '90px' }}>Time</th>
                <th style={{ width: '75px' }}>Iface</th>
                <th style={{ width: '130px' }}>Source</th>
                <th style={{ width: '130px' }}>Dest</th>
                <th style={{ width: '50px' }}>Proto</th>
                <th>Info</th>
              </tr>
            </thead>
            <tbody>
              {filteredPackets.length === 0 ? (
                <tr><td colSpan="7" style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>
                  {capturing ? 'Waiting for packets...' : 'Select interface and Start'}
                </td></tr>
              ) : (
                filteredPackets.map(pkt => (
                  <tr key={pkt.id} onClick={() => setSelectedPacket(pkt)}
                    style={{ cursor: 'pointer', background: selectedPacket?.id === pkt.id ? '#f1f5f9' : '' }}>
                    <td>{pkt.id}</td>
                    <td>{formatTime(pkt.time)}</td>
                    <td>{pkt.interface?.split(/[:/]/)[0]}</td>
                    <td>{pkt.source}{pkt.srcPort ? `:${pkt.srcPort}` : ''}</td>
                    <td>{pkt.destination}{pkt.dstPort ? `:${pkt.dstPort}` : ''}</td>
                    <td>
                      <span style={{
                        padding: '1px 5px', borderRadius: '3px', fontSize: '0.7rem',
                        background: getProtocolColor(pkt.protocol) + '22',
                        color: getProtocolColor(pkt.protocol)
                      }}>{pkt.protocol}</span>
                    </td>
                    <td style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '250px' }}>
                      {pkt.info}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Packet Details */}
      {selectedPacket && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div className="card">
            <h3 style={{ fontSize: '0.9rem', marginBottom: '12px' }}>Packet #{selectedPacket.id}</h3>
            <div style={{ fontSize: '0.8rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div style={{ padding: '6px', background: '#f8fafc', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.65rem', color: '#64748b' }}>Source</div>
                <div style={{ fontFamily: 'monospace' }}>{selectedPacket.source}:{selectedPacket.srcPort}</div>
              </div>
              <div style={{ padding: '6px', background: '#f8fafc', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.65rem', color: '#64748b' }}>Destination</div>
                <div style={{ fontFamily: 'monospace' }}>{selectedPacket.destination}:{selectedPacket.dstPort}</div>
              </div>
            </div>

            {selectedPacket.coap && (
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e2e8f0' }}>
                <div style={{ fontWeight: '600', color: '#4ade80', marginBottom: '8px' }}>CoAP</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', fontSize: '0.8rem' }}>
                  <div style={{ padding: '4px', background: '#f8fafc', borderRadius: '4px' }}>
                    <div style={{ fontSize: '0.6rem', color: '#64748b' }}>Type</div>
                    <div>{selectedPacket.coap.type}</div>
                  </div>
                  <div style={{ padding: '4px', background: '#f8fafc', borderRadius: '4px' }}>
                    <div style={{ fontSize: '0.6rem', color: '#64748b' }}>Code</div>
                    <div style={{ color: getCodeColor(selectedPacket.coap.code) }}>{selectedPacket.coap.code}</div>
                  </div>
                  <div style={{ padding: '4px', background: '#f8fafc', borderRadius: '4px' }}>
                    <div style={{ fontSize: '0.6rem', color: '#64748b' }}>MID</div>
                    <div>{selectedPacket.coap.messageId}</div>
                  </div>
                  <div style={{ padding: '4px', background: '#f8fafc', borderRadius: '4px' }}>
                    <div style={{ fontSize: '0.6rem', color: '#64748b' }}>Token</div>
                    <div>{selectedPacket.coap.token || '-'}</div>
                  </div>
                </div>
              </div>
            )}

            {selectedPacket.ptp && (
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e2e8f0' }}>
                <div style={{ fontWeight: '600', color: '#a78bfa', marginBottom: '8px' }}>PTP</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', fontSize: '0.8rem' }}>
                  <div style={{ padding: '4px', background: '#f8fafc', borderRadius: '4px' }}>
                    <div style={{ fontSize: '0.6rem', color: '#64748b' }}>Type</div>
                    <div>{selectedPacket.ptp.msgType}</div>
                  </div>
                  <div style={{ padding: '4px', background: '#f8fafc', borderRadius: '4px' }}>
                    <div style={{ fontSize: '0.6rem', color: '#64748b' }}>Seq</div>
                    <div>{selectedPacket.ptp.sequenceId}</div>
                  </div>
                  <div style={{ padding: '4px', background: '#f8fafc', borderRadius: '4px' }}>
                    <div style={{ fontSize: '0.6rem', color: '#64748b' }}>Domain</div>
                    <div>{selectedPacket.ptp.domain}</div>
                  </div>
                </div>
                {selectedPacket.ptp.correctionField !== undefined && (
                  <div style={{ marginTop: '8px', padding: '8px', background: '#f5f3ff', borderRadius: '6px' }}>
                    <div style={{ fontSize: '0.65rem', color: '#6366f1' }}>Correction Field</div>
                    <div style={{ fontSize: '1rem', fontWeight: '600', fontFamily: 'monospace' }}>
                      {selectedPacket.ptp.correctionField} ns
                    </div>
                  </div>
                )}
                {selectedPacket.ptp.clockId && (
                  <div style={{ marginTop: '8px', fontSize: '0.75rem', color: '#64748b', fontFamily: 'monospace' }}>
                    Clock: {selectedPacket.ptp.clockId}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{ fontSize: '0.9rem', marginBottom: '12px' }}>Hex ({selectedPacket.length} bytes)</h3>
            <div style={{
              fontFamily: 'monospace', fontSize: '0.68rem',
              background: '#1e293b', color: '#e2e8f0',
              padding: '10px', borderRadius: '6px',
              overflow: 'auto', maxHeight: '200px'
            }}>
              {formatHexDump(selectedPacket.hex, selectedPacket.ascii).map((line, i) => (
                <div key={i} style={{ display: 'flex', gap: '10px' }}>
                  <span style={{ color: '#64748b' }}>{line.offset}</span>
                  <span style={{ color: '#60a5fa' }}>{line.hex}</span>
                  <span style={{ color: '#4ade80' }}>{line.ascii}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Capture
