import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useDevices } from '../contexts/DeviceContext'

function Ports() {
  const { selectedDevice } = useDevices()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [ports, setPorts] = useState([])
  const [selectedPort, setSelectedPort] = useState(null)
  const [portDetail, setPortDetail] = useState(null)
  const [portStats, setPortStats] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [lastFetched, setLastFetched] = useState(null)

  // Real-time monitoring
  const [monitoring, setMonitoring] = useState(false)
  const [statsHistory, setStatsHistory] = useState([])
  const [prevStats, setPrevStats] = useState(null)
  const monitoringRef = useRef(false)
  const pollIntervalRef = useRef(null)

  const portCount = 12 // LAN9692: 7 PHY + 4 SFP + 1 internal
  const cacheKey = `ports_${selectedDevice?.host || selectedDevice?.device || 'default'}`

  // Load cached data on mount
  useEffect(() => {
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      try {
        const data = JSON.parse(cached)
        setPorts(data.ports || [])
        setLastFetched(data.timestamp ? new Date(data.timestamp) : null)
      } catch (e) {
        console.error('Failed to load cached ports:', e)
      }
    }
  }, [cacheKey])

  // Save to cache when ports change
  const saveCache = (portData) => {
    const data = { ports: portData, timestamp: new Date().toISOString() }
    localStorage.setItem(cacheKey, JSON.stringify(data))
    setLastFetched(new Date())
  }

  // Small delay helper
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  // Fetch single port basic status with timeout
  const fetchPortStatus = async (portNum) => {
    if (!selectedDevice) return { number: portNum, operStatus: 'unknown', error: 'No device selected' }

    const basePath = `/ietf-interfaces:interfaces/interface[name='${portNum}']`
    try {
      const response = await axios.post('/api/fetch', {
        paths: [`${basePath}/oper-status`],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 8000 })

      const result = response.data.result || ''
      const operStatus = result.includes('up') ? 'up' : 'down'
      return { number: portNum, operStatus, error: null }
    } catch (err) {
      return { number: portNum, operStatus: 'unknown', error: err.message }
    }
  }

  // Fetch all ports status (one by one to avoid overwhelming the device)
  const fetchAllPorts = useCallback(async () => {
    setLoading(true)
    setError(null)
    const portData = []

    for (let i = 1; i <= portCount; i++) {
      // Add small delay between requests to let device recover
      if (i > 1) await delay(200)
      const status = await fetchPortStatus(i)
      portData.push(status)
      // Update state incrementally so user sees progress
      setPorts([...portData])
    }

    // Save successful fetch to cache
    saveCache(portData)
    setLoading(false)
  }, [selectedDevice, cacheKey])

  // Fetch detailed info for selected port
  const fetchPortDetail = async (portNum) => {
    if (!selectedDevice) return
    setDetailLoading(true)
    const basePath = `/ietf-interfaces:interfaces/interface[name='${portNum}']`

    try {
      // Fetch config and status
      const response = await axios.post('/api/fetch', {
        paths: [
          `${basePath}/enabled`,
          `${basePath}/oper-status`,
          `${basePath}/phys-address`,
          `${basePath}/mchp-velocitysp-port:eth-port/config`
        ],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 10000 })

      const detail = parseDetailResponse(response.data.result, portNum)
      setPortDetail(detail)

      // Fetch statistics separately
      const statsResponse = await axios.post('/api/fetch', {
        paths: [`${basePath}/statistics`],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 10000 })

      const stats = parseStatsResponse(statsResponse.data.result)
      setPortStats(stats)

    } catch (err) {
      setError(`Port ${portNum}: ${err.message}`)
    } finally {
      setDetailLoading(false)
    }
  }

  // Parse detail response
  const parseDetailResponse = (result, portNum) => {
    const data = {
      number: portNum,
      enabled: true,
      operStatus: 'unknown',
      macAddress: '-',
      speed: '-',
      duplex: '-',
      maxFrameLength: 0
    }

    if (!result) return data

    const lines = result.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('enabled:')) {
        data.enabled = trimmed.includes('true')
      } else if (trimmed.startsWith('oper-status:')) {
        data.operStatus = trimmed.split(':')[1]?.trim() || 'unknown'
      } else if (trimmed.startsWith('phys-address:')) {
        data.macAddress = trimmed.split(':').slice(1).join(':').trim() || '-'
      } else if (trimmed.startsWith('speed:')) {
        data.speed = trimmed.split(':')[1]?.trim().replace(/'/g, '') || '-'
      } else if (trimmed.startsWith('duplex:')) {
        data.duplex = trimmed.split(':')[1]?.trim() || '-'
      } else if (trimmed.startsWith('max-frame-length:')) {
        data.maxFrameLength = parseInt(trimmed.split(':')[1]?.trim()) || 0
      }
    }

    return data
  }

  // Parse statistics response
  const parseStatsResponse = (result) => {
    const stats = {
      inOctets: 0,
      outOctets: 0,
      inUnicast: 0,
      outUnicast: 0,
      inBroadcast: 0,
      outBroadcast: 0,
      inMulticast: 0,
      outMulticast: 0,
      inDiscards: 0,
      outDiscards: 0,
      inErrors: 0,
      outErrors: 0
    }

    if (!result) return stats

    const lines = result.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      const getValue = (str) => parseInt(str.split(':')[1]?.replace(/'/g, '').trim()) || 0

      if (trimmed.startsWith('in-octets:')) stats.inOctets = getValue(trimmed)
      else if (trimmed.startsWith('out-octets:')) stats.outOctets = getValue(trimmed)
      else if (trimmed.startsWith('in-unicast-pkts:')) stats.inUnicast = getValue(trimmed)
      else if (trimmed.startsWith('out-unicast-pkts:')) stats.outUnicast = getValue(trimmed)
      else if (trimmed.startsWith('in-broadcast-pkts:')) stats.inBroadcast = getValue(trimmed)
      else if (trimmed.startsWith('out-broadcast-pkts:')) stats.outBroadcast = getValue(trimmed)
      else if (trimmed.startsWith('in-multicast-pkts:')) stats.inMulticast = getValue(trimmed)
      else if (trimmed.startsWith('out-multicast-pkts:')) stats.outMulticast = getValue(trimmed)
      else if (trimmed.startsWith('in-discards:')) stats.inDiscards = getValue(trimmed)
      else if (trimmed.startsWith('out-discards:')) stats.outDiscards = getValue(trimmed)
      else if (trimmed.startsWith('in-errors:')) stats.inErrors = getValue(trimmed)
      else if (trimmed.startsWith('out-errors:')) stats.outErrors = getValue(trimmed)
    }

    return stats
  }

  // Fetch stats for monitoring (lightweight, no state updates except stats)
  const fetchStatsOnly = async (portNum) => {
    if (!selectedDevice) return null
    const basePath = `/ietf-interfaces:interfaces/interface[name='${portNum}']`
    try {
      const response = await axios.post('/api/fetch', {
        paths: [`${basePath}/statistics`],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 5000 })
      return parseStatsResponse(response.data.result)
    } catch {
      return null
    }
  }

  // Start/stop monitoring
  const toggleMonitoring = () => {
    if (monitoring) {
      // Stop monitoring
      monitoringRef.current = false
      setMonitoring(false)
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    } else {
      // Start monitoring
      monitoringRef.current = true
      setMonitoring(true)
      setStatsHistory([])
      setPrevStats(null)

      // Poll every 2 seconds
      const poll = async () => {
        if (!monitoringRef.current || !selectedPort) return

        const stats = await fetchStatsOnly(selectedPort)
        if (!stats || !monitoringRef.current) return

        setStatsHistory(prev => {
          const now = new Date()
          const timeLabel = now.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

          // Calculate rate (bytes/sec)
          let rxRate = 0, txRate = 0
          if (prevStats) {
            rxRate = Math.max(0, stats.inOctets - prevStats.inOctets) / 2  // 2 second interval
            txRate = Math.max(0, stats.outOctets - prevStats.outOctets) / 2
          }
          setPrevStats(stats)

          const newEntry = {
            time: timeLabel,
            rx: Math.round(rxRate),
            tx: Math.round(txRate),
            rxTotal: stats.inOctets,
            txTotal: stats.outOctets
          }

          // Keep last 30 data points (1 minute of data)
          const updated = [...prev, newEntry]
          if (updated.length > 30) updated.shift()
          return updated
        })
      }

      // Initial poll
      poll()
      pollIntervalRef.current = setInterval(poll, 2000)
    }
  }

  // Cleanup monitoring on port change or unmount
  useEffect(() => {
    return () => {
      monitoringRef.current = false
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [])

  // Stop monitoring when port changes
  useEffect(() => {
    if (monitoring) {
      monitoringRef.current = false
      setMonitoring(false)
      setStatsHistory([])
      setPrevStats(null)
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [selectedPort])

  // Toggle port enabled state
  const togglePort = async (portNum, currentEnabled) => {
    if (!selectedDevice) return
    setDetailLoading(true)
    try {
      await axios.post('/api/patch', {
        patches: [{
          path: `/ietf-interfaces:interfaces/interface[name='${portNum}']/enabled`,
          value: !currentEnabled
        }],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 10000 })

      // Refresh detail
      await fetchPortDetail(portNum)
      // Update overview
      setPorts(ports.map(p =>
        p.number === portNum ? { ...p, operStatus: !currentEnabled ? 'down' : p.operStatus } : p
      ))
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setDetailLoading(false)
    }
  }

  // Clear port counters
  const clearCounters = async (portNum) => {
    if (!selectedDevice) return
    setDetailLoading(true)
    try {
      await axios.post('/api/patch', {
        patches: [{
          path: `/ietf-interfaces:interfaces/interface[name='${portNum}']/mchp-velocitysp-port:eth-port/statistics/clear-statistics`,
          value: null
        }],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 10000 })

      await fetchPortDetail(portNum)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setDetailLoading(false)
    }
  }

  // Initial fetch only if no cache
  useEffect(() => {
    if (!selectedDevice) return
    const cached = localStorage.getItem(cacheKey)
    if (!cached) {
      fetchAllPorts()
    }
  }, [selectedDevice])

  // Fetch detail when port selected
  useEffect(() => {
    if (selectedPort) {
      setPortDetail(null)
      setPortStats(null)
      fetchPortDetail(selectedPort)
    }
  }, [selectedPort])

  const formatSpeed = (speed) => {
    if (!speed || speed === '-') return '-'
    const num = parseFloat(speed)
    if (isNaN(num)) return speed
    if (num >= 1) return `${num} Gbps`
    return `${Math.round(num * 1000)} Mbps`
  }

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Port Status</h1>
        <p className="page-description">Switch port monitoring and configuration</p>
      </div>

      {/* Connection Info */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Connection</h2>
          <button
            className="btn btn-secondary"
            onClick={fetchAllPorts}
            disabled={loading}
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
          >
            {loading ? `Loading... (${ports.length}/${portCount})` : 'Refresh All'}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px', background: '#f8fafc', borderRadius: '6px' }}>
          <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
            {selectedDevice ? (selectedDevice.transport === 'wifi' ? `${selectedDevice.host}:${selectedDevice.port}` : selectedDevice.device) : 'No device selected'}
          </span>
          {lastFetched && (
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
              Last updated: {lastFetched.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {/* Port Overview Grid */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Port Overview</h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '8px' }}>
          {Array.from({ length: portCount }, (_, i) => i + 1).map((portNum) => {
            const port = ports.find(p => p.number === portNum)
            const isSelected = selectedPort === portNum
            const status = port?.operStatus || 'loading'

            return (
              <div
                key={portNum}
                onClick={() => setSelectedPort(portNum)}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  border: isSelected ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                  background: isSelected ? '#eff6ff' : '#fff',
                  cursor: 'pointer',
                  textAlign: 'center',
                  transition: 'all 0.15s'
                }}
              >
                <div style={{ fontSize: '1rem', fontWeight: '600', marginBottom: '6px' }}>
                  Port {portNum}
                </div>
                <div
                  style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    fontSize: '0.7rem',
                    fontWeight: '500',
                    background: status === 'up' ? '#dcfce7' : status === 'down' ? '#fee2e2' : '#f1f5f9',
                    color: status === 'up' ? '#166534' : status === 'down' ? '#991b1b' : '#64748b'
                  }}
                >
                  {status === 'up' ? 'UP' : status === 'down' ? 'DOWN' : status === 'loading' ? '...' : 'ERR'}
                </div>
                {port?.error && (
                  <div style={{ fontSize: '0.65rem', color: '#ef4444', marginTop: '4px' }}>timeout</div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Selected Port Details */}
      {selectedPort && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Port {selectedPort} Details</h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => fetchPortDetail(selectedPort)}
                disabled={detailLoading}
                style={{ fontSize: '0.8rem', padding: '6px 12px' }}
              >
                {detailLoading ? 'Loading...' : 'Refresh'}
              </button>
              {portStats && (
                <button
                  className="btn btn-secondary"
                  onClick={() => clearCounters(selectedPort)}
                  disabled={detailLoading}
                  style={{ fontSize: '0.8rem', padding: '6px 12px' }}
                >
                  Clear Counters
                </button>
              )}
            </div>
          </div>

          {detailLoading && !portDetail && (
            <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
              Loading port details...
            </div>
          )}

          {/* Port Config */}
          {portDetail && (
            <div style={{ marginBottom: '20px' }}>
              <h3 style={{ fontSize: '0.9rem', fontWeight: '600', marginBottom: '12px', color: '#334155' }}>
                Configuration
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
                <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '4px' }}>Admin State</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: '500' }}>{portDetail.enabled ? 'Enabled' : 'Disabled'}</span>
                    <button
                      className={`btn ${portDetail.enabled ? 'btn-danger' : 'btn-primary'}`}
                      onClick={() => togglePort(portDetail.number, portDetail.enabled)}
                      disabled={detailLoading}
                      style={{ fontSize: '0.7rem', padding: '3px 8px' }}
                    >
                      {portDetail.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </div>
                <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '4px' }}>Link Status</div>
                  <div style={{ fontWeight: '500', color: portDetail.operStatus === 'up' ? '#16a34a' : '#64748b' }}>
                    {portDetail.operStatus === 'up' ? 'Link Up' : 'Link Down'}
                  </div>
                </div>
                <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '4px' }}>Speed / Duplex</div>
                  <div style={{ fontWeight: '500' }}>
                    {formatSpeed(portDetail.speed)} / {portDetail.duplex}
                  </div>
                </div>
                <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '4px' }}>MAC Address</div>
                  <div style={{ fontWeight: '500', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {portDetail.macAddress}
                  </div>
                </div>
                <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '4px' }}>Max Frame</div>
                  <div style={{ fontWeight: '500' }}>{portDetail.maxFrameLength} bytes</div>
                </div>
              </div>
            </div>
          )}

          {/* Port Statistics */}
          {portStats && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h3 style={{ fontSize: '0.9rem', fontWeight: '600', color: '#334155', margin: 0 }}>
                  Statistics
                </h3>
                <button
                  className={`btn ${monitoring ? 'btn-danger' : 'btn-primary'}`}
                  onClick={toggleMonitoring}
                  style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                >
                  {monitoring ? 'Stop Monitoring' : 'Start Monitoring'}
                </button>
              </div>

              {/* Real-time Graph */}
              {monitoring && statsHistory.length > 0 && (
                <div style={{ marginBottom: '20px', padding: '16px', background: '#f8fafc', borderRadius: '8px' }}>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '12px', color: '#475569' }}>
                    Traffic Rate (Bytes/sec)
                  </h4>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={statsHistory} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 10 }}
                        tickLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={(val) => {
                          if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`
                          if (val >= 1000) return `${(val / 1000).toFixed(0)}K`
                          return val
                        }}
                      />
                      <Tooltip
                        formatter={(value, name) => {
                          const label = name === 'rx' ? 'RX' : 'TX'
                          if (value >= 1000000) return [`${(value / 1000000).toFixed(2)} MB/s`, label]
                          if (value >= 1000) return [`${(value / 1000).toFixed(2)} KB/s`, label]
                          return [`${value} B/s`, label]
                        }}
                        labelStyle={{ fontSize: 11 }}
                        contentStyle={{ fontSize: 11 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line
                        type="monotone"
                        dataKey="rx"
                        stroke="#22c55e"
                        strokeWidth={2}
                        dot={false}
                        name="RX"
                        isAnimationActive={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="tx"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={false}
                        name="TX"
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '24px', marginTop: '8px', fontSize: '0.75rem', color: '#64748b' }}>
                    <span>Polling: 2s interval</span>
                    <span>History: {statsHistory.length} samples</span>
                  </div>
                </div>
              )}

              {monitoring && statsHistory.length === 0 && (
                <div style={{ marginBottom: '20px', padding: '24px', background: '#f8fafc', borderRadius: '8px', textAlign: 'center', color: '#64748b' }}>
                  Collecting data...
                </div>
              )}

              {/* Summary */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px', marginBottom: '16px' }}>
                <div style={{ padding: '12px', background: '#f0fdf4', borderRadius: '6px', borderLeft: '3px solid #22c55e' }}>
                  <div style={{ fontSize: '0.7rem', color: '#64748b' }}>RX Bytes</div>
                  <div style={{ fontWeight: '600', fontSize: '1rem' }}>{formatBytes(portStats.inOctets)}</div>
                </div>
                <div style={{ padding: '12px', background: '#eff6ff', borderRadius: '6px', borderLeft: '3px solid #3b82f6' }}>
                  <div style={{ fontSize: '0.7rem', color: '#64748b' }}>TX Bytes</div>
                  <div style={{ fontWeight: '600', fontSize: '1rem' }}>{formatBytes(portStats.outOctets)}</div>
                </div>
                <div style={{ padding: '12px', background: '#f0fdf4', borderRadius: '6px', borderLeft: '3px solid #22c55e' }}>
                  <div style={{ fontSize: '0.7rem', color: '#64748b' }}>RX Packets</div>
                  <div style={{ fontWeight: '600', fontSize: '1rem' }}>
                    {(portStats.inUnicast + portStats.inBroadcast + portStats.inMulticast).toLocaleString()}
                  </div>
                </div>
                <div style={{ padding: '12px', background: '#eff6ff', borderRadius: '6px', borderLeft: '3px solid #3b82f6' }}>
                  <div style={{ fontSize: '0.7rem', color: '#64748b' }}>TX Packets</div>
                  <div style={{ fontWeight: '600', fontSize: '1rem' }}>
                    {(portStats.outUnicast + portStats.outBroadcast + portStats.outMulticast).toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Detailed Table */}
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Counter</th>
                      <th style={{ textAlign: 'right' }}>RX</th>
                      <th style={{ textAlign: 'right' }}>TX</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Unicast</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{portStats.inUnicast.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{portStats.outUnicast.toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td>Broadcast</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{portStats.inBroadcast.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{portStats.outBroadcast.toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td>Multicast</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{portStats.inMulticast.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{portStats.outMulticast.toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td>Discards</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{portStats.inDiscards}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{portStats.outDiscards}</td>
                    </tr>
                    <tr>
                      <td>Errors</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: portStats.inErrors > 0 ? '#ef4444' : 'inherit' }}>
                        {portStats.inErrors}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: portStats.outErrors > 0 ? '#ef4444' : 'inherit' }}>
                        {portStats.outErrors}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="alert alert-error" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem' }}>×</button>
        </div>
      )}
    </div>
  )
}

export default Ports
