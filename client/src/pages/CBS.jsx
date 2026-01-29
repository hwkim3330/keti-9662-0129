import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

function CBS() {
  const { devices, selectedDevice, selectDevice } = useDevices()
  const [deviceStatuses, setDeviceStatuses] = useState({})

  const [portNumber, setPortNumber] = useState('8')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastResult, setLastResult] = useState(null)

  // Auto refresh
  const [autoRefresh, setAutoRefresh] = useState(false)
  const intervalRef = useRef(null)
  const fetchingRef = useRef(false)

  // CBS Configuration
  const [shaperTC, setShaperTC] = useState(3)
  const [idleSlope, setIdleSlope] = useState(100000) // kbps

  const getQosPath = (port) => `/ietf-interfaces:interfaces/interface[name='${port}']/mchp-velocitysp-port:eth-qos/config`

  // Parse CBS status from YAML
  const parseStatus = (yamlStr) => {
    if (!yamlStr) return { shapers: [] }
    const shapers = []
    try {
      const lines = yamlStr.split('\n')
      let current = null

      for (const line of lines) {
        if (line.includes('traffic-class:')) {
          if (current) shapers.push(current)
          current = { tc: parseInt(line.split(':')[1].trim()) }
        } else if (line.includes('idle-slope:') && current) {
          current.idleSlope = parseInt(line.split(':')[1].trim())
          current.type = 'credit-based'
        }
      }
      if (current) shapers.push(current)
    } catch {}
    return { shapers }
  }

  // Fetch status for a single device
  const fetchDeviceStatus = async (device) => {
    try {
      const res = await axios.post('/api/fetch', {
        paths: [`${getQosPath(portNumber)}/traffic-class-shapers`],
        transport: device.transport,
        device: device.device,
        host: device.host,
        port: device.port || 5683
      }, { timeout: 10000 })

      const parsed = parseStatus(res.data.result)
      return { ...parsed, online: true, raw: res.data.result }
    } catch (err) {
      return { online: false, error: err.message, shapers: [] }
    }
  }

  // Fetch all device statuses
  const fetchAllStatuses = async (silent = false) => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    if (!silent) setLoading(true)

    try {
      for (const device of devices) {
        const status = await fetchDeviceStatus(device)
        setDeviceStatuses(prev => ({ ...prev, [device.id]: status }))
        await new Promise(r => setTimeout(r, 200))
      }
      if (!silent) setError(null)
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      fetchingRef.current = false
      if (!silent) setLoading(false)
    }
  }

  // Initial fetch
  useEffect(() => {
    if (devices.length > 0) {
      fetchAllStatuses(false)
    }
  }, [devices, portNumber])

  // Auto refresh
  useEffect(() => {
    if (autoRefresh && devices.length > 0) {
      intervalRef.current = setInterval(() => fetchAllStatuses(true), 3000)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [autoRefresh, devices, portNumber])

  // Apply CBS shaper
  const applyCBS = async () => {
    if (!selectedDevice) return
    setLoading(true)
    setError(null)
    setLastResult(null)

    try {
      const res = await axios.post('/api/patch', {
        patches: [{
          path: `${getQosPath(portNumber)}/traffic-class-shapers`,
          value: {
            'traffic-class': shaperTC,
            'credit-based': { 'idle-slope': idleSlope }
          }
        }],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      })
      setLastResult(res.data)
      setTimeout(() => fetchAllStatuses(true), 500)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  // Delete shaper
  const deleteShaper = async (tc) => {
    if (!selectedDevice) return
    setLoading(true)
    setError(null)

    try {
      await axios.post('/api/patch', {
        patches: [{
          path: `${getQosPath(portNumber)}/traffic-class-shapers[traffic-class='${tc}']`,
          value: null
        }],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      })
      setTimeout(() => fetchAllStatuses(true), 500)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">CBS (802.1Qav)</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select
            className="form-select"
            value={portNumber}
            onChange={(e) => setPortNumber(e.target.value)}
            style={{ width: '100px' }}
          >
            {[1,2,3,4,5,6,7,8,9,10,11,12].map(p => <option key={p} value={p}>Port {p}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto
          </label>
          <button className="btn btn-secondary" onClick={() => fetchAllStatuses(false)} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {/* Device Status Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(devices.length, 3)}, 1fr)`, gap: '12px', marginBottom: '16px' }}>
        {devices.map(device => {
          const status = deviceStatuses[device.id] || {}
          const isSelected = selectedDevice?.id === device.id

          return (
            <div
              key={device.id}
              onClick={() => selectDevice(device)}
              style={{
                padding: '16px',
                background: isSelected ? '#f1f5f9' : '#fff',
                border: isSelected ? '2px solid #475569' : status.online ? '1px solid #d1d5db' : '1px solid #fca5a5',
                borderRadius: '12px',
                cursor: 'pointer'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontWeight: '600', fontSize: '0.95rem' }}>{device.name}</div>
                  <div style={{ fontSize: '0.7rem', color: '#64748b', fontFamily: 'monospace' }}>
                    {device.transport === 'serial' ? device.device : device.host}
                  </div>
                </div>
                <div style={{
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '0.75rem',
                  fontWeight: '600',
                  background: !status.online ? '#fef2f2' : status.shapers?.length > 0 ? '#ecfdf5' : '#f8fafc',
                  color: !status.online ? '#b91c1c' : status.shapers?.length > 0 ? '#059669' : '#64748b'
                }}>
                  {!status.online ? 'OFFLINE' : status.shapers?.length > 0 ? `${status.shapers.length} TC` : 'NONE'}
                </div>
              </div>

              {status.online ? (
                <div style={{ fontSize: '0.8rem' }}>
                  {status.shapers?.length > 0 ? (
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {status.shapers.map((s, i) => (
                        <span key={i} style={{ padding: '4px 8px', background: '#f1f5f9', borderRadius: '4px' }}>
                          TC{s.tc}: {s.idleSlope ? `${(s.idleSlope / 1000).toFixed(1)} Mbps` : '-'}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ color: '#94a3b8' }}>No shapers configured</div>
                  )}
                </div>
              ) : (
                <div style={{ padding: '12px', textAlign: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
                  {status.error || 'Offline'}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {devices.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
          No devices configured. Go to Settings to add devices.
        </div>
      )}

      {/* Configure CBS */}
      {selectedDevice && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Configure CBS</h2>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '16px' }}>
            Credit-Based Shaper for time-sensitive streams.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px' }}>
            <div>
              <label className="form-label">Traffic Class</label>
              <select className="form-select" value={shaperTC} onChange={(e) => setShaperTC(parseInt(e.target.value))}>
                {[0,1,2,3,4,5,6,7].map(tc => <option key={tc} value={tc}>TC {tc}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Idle Slope (kbps)</label>
              <input
                type="number"
                className="form-input"
                value={idleSlope}
                onChange={(e) => setIdleSlope(parseInt(e.target.value) || 0)}
              />
            </div>
            <div>
              <label className="form-label">Rate</label>
              <div style={{ padding: '10px', background: '#f8fafc', borderRadius: '6px', fontFamily: 'monospace' }}>
                {idleSlope > 0 ? `${(idleSlope / 1000).toFixed(1)} Mbps` : '-'}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-primary" onClick={applyCBS} disabled={loading}>
              {loading ? 'Applying...' : 'Apply CBS'}
            </button>
          </div>

          {/* Current Shapers for Selected Device */}
          {deviceStatuses[selectedDevice?.id]?.shapers?.length > 0 && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '8px' }}>Active Shapers</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {deviceStatuses[selectedDevice.id].shapers.map((s, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '8px 12px', background: '#f8fafc', borderRadius: '6px'
                  }}>
                    <span>TC{s.tc}: {(s.idleSlope / 1000).toFixed(1)} Mbps</span>
                    <button
                      onClick={() => deleteShaper(s.tc)}
                      disabled={loading}
                      style={{
                        background: 'none', border: 'none', color: '#dc2626',
                        cursor: 'pointer', fontSize: '0.8rem', padding: '2px'
                      }}
                    >
                      X
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {lastResult && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Result</h2>
          </div>
          <div style={{ fontSize: '0.85rem' }}>
            {lastResult.results?.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: '8px', padding: '2px 0' }}>
                <span style={{ color: r.success ? '#16a34a' : '#dc2626' }}>{r.success ? 'OK' : 'Fail'}</span>
                <span>{r.path.split('/').pop()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default CBS
