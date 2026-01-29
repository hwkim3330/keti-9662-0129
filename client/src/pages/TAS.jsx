import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

function TAS() {
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

  // Admin config (editable)
  const [gateEnabled, setGateEnabled] = useState(true)
  const [adminGateStates, setAdminGateStates] = useState(255)
  const [cycleTimeUs, setCycleTimeUs] = useState(1000)
  const [cycleTimeExtensionUs, setCycleTimeExtensionUs] = useState(10)
  const [baseTimeSeconds, setBaseTimeSeconds] = useState(100)

  // Gate Control List
  const [gateEntries, setGateEntries] = useState([
    { timeUs: 125, gates: [true, false, false, false, false, false, false, false] },
    { timeUs: 125, gates: [false, true, false, false, false, false, false, false] },
    { timeUs: 125, gates: [false, false, true, false, false, false, false, false] },
    { timeUs: 125, gates: [false, false, false, true, false, false, false, false] },
    { timeUs: 125, gates: [false, false, false, false, true, false, false, false] },
    { timeUs: 125, gates: [false, false, false, false, false, true, false, false] },
    { timeUs: 125, gates: [false, false, false, false, false, false, true, false] },
    { timeUs: 125, gates: [false, false, false, false, false, false, false, true] },
  ])


  const getBasePath = (port) => `/ietf-interfaces:interfaces/interface[name='${port}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table`

  // Parse TAS status from YAML
  const parseStatus = (yamlStr) => {
    if (!yamlStr) return null
    const status = {
      gateEnabled: false,
      adminGateStates: 255,
      operGateStates: 255,
      cycleTimeNs: 0,
      configPending: false,
      adminControlList: [],
      operControlList: []
    }

    try {
      status.gateEnabled = yamlStr.includes('gate-enabled: true')

      const adminGatesMatch = yamlStr.match(/admin-gate-states:\s*(\d+)/)
      if (adminGatesMatch) status.adminGateStates = parseInt(adminGatesMatch[1])

      const operGatesMatch = yamlStr.match(/oper-gate-states:\s*(\d+)/)
      if (operGatesMatch) status.operGateStates = parseInt(operGatesMatch[1])

      const cycleMatch = yamlStr.match(/numerator:\s*(\d+)/)
      if (cycleMatch) status.cycleTimeNs = parseInt(cycleMatch[1])

      status.configPending = yamlStr.includes('config-pending: true')

      // Parse admin control list
      const adminSection = yamlStr.match(/admin-control-list:[\s\S]*?(?=oper-control-list:|$)/)?.[0]
      if (adminSection) {
        const entries = adminSection.match(/gate-states-value:\s*(\d+)[\s\S]*?time-interval-value:\s*(\d+)/g)
        if (entries) {
          status.adminControlList = entries.map(e => {
            const gs = e.match(/gate-states-value:\s*(\d+)/)?.[1]
            const ti = e.match(/time-interval-value:\s*(\d+)/)?.[1]
            return { gateStates: parseInt(gs) || 0, timeInterval: parseInt(ti) || 0 }
          })
        }
      }

      return status
    } catch {
      return status
    }
  }

  // Fetch status for a single device
  const fetchDeviceStatus = async (device) => {
    try {
      const res = await axios.post('/api/fetch', {
        paths: [getBasePath(portNumber)],
        transport: device.transport,
        device: device.device,
        host: device.host,
        port: device.port || 5683
      }, { timeout: 10000 })

      const parsed = parseStatus(res.data.result)
      return { ...parsed, online: true, raw: res.data.result }
    } catch (err) {
      return { online: false, error: err.message }
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

  // Convert gates array to integer
  const gatesToInt = (gates) => gates.reduce((acc, open, idx) => acc | (open ? (1 << idx) : 0), 0)

  // Toggle a gate
  const toggleGate = (entryIdx, tcIdx) => {
    const updated = [...gateEntries]
    updated[entryIdx].gates[tcIdx] = !updated[entryIdx].gates[tcIdx]
    setGateEntries(updated)
  }

  // Update time for an entry
  const updateEntryTime = (entryIdx, timeUs) => {
    const updated = [...gateEntries]
    updated[entryIdx].timeUs = parseInt(timeUs) || 0
    setGateEntries(updated)
  }

  // Add/remove entry
  const addEntry = () => setGateEntries([...gateEntries, { timeUs: 125, gates: [true, true, true, true, true, true, true, true] }])
  const removeEntry = (idx) => gateEntries.length > 1 && setGateEntries(gateEntries.filter((_, i) => i !== idx))

  const totalTimeUs = gateEntries.reduce((sum, e) => sum + e.timeUs, 0)

  // Apply configuration
  const applyConfig = async () => {
    if (!selectedDevice) return
    if (cycleTimeUs < totalTimeUs) {
      setError(`Cycle time (${cycleTimeUs} us) must be >= total GCL time (${totalTimeUs} us)`)
      return
    }

    setLoading(true)
    setError(null)
    setLastResult(null)

    const basePath = getBasePath(portNumber)
    const patches = [
      { path: `${basePath}/gate-enabled`, value: gateEnabled },
      { path: `${basePath}/admin-gate-states`, value: adminGateStates },
      ...gateEntries.map((entry, idx) => ({
        path: `${basePath}/admin-control-list/gate-control-entry`,
        value: {
          index: idx + 1,
          'operation-name': 'ieee802-dot1q-sched:set-gate-states',
          'time-interval-value': entry.timeUs * 1000,
          'gate-states-value': gatesToInt(entry.gates)
        }
      })),
      { path: `${basePath}/admin-cycle-time/numerator`, value: cycleTimeUs * 1000 },
      { path: `${basePath}/admin-cycle-time/denominator`, value: 1 },
      { path: `${basePath}/admin-cycle-time-extension`, value: cycleTimeExtensionUs * 1000 },
      { path: `${basePath}/admin-base-time/seconds`, value: String(baseTimeSeconds) },
      { path: `${basePath}/admin-base-time/nanoseconds`, value: 0 }
    ]

    try {
      const res = await axios.post('/api/patch', {
        patches,
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 30000 })
      setLastResult(res.data)
      setTimeout(() => fetchAllStatuses(true), 500)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  // Trigger config change
  const triggerConfigChange = async () => {
    if (!selectedDevice) return
    setLoading(true)
    setError(null)

    try {
      const res = await axios.post('/api/patch', {
        patches: [{ path: `${getBasePath(portNumber)}/config-change`, value: true }],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 10000 })
      setLastResult(res.data)
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
        <h1 className="page-title">TAS (802.1Qbv)</h1>
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
                  background: !status.online ? '#fef2f2' : status.gateEnabled ? '#ecfdf5' : '#f8fafc',
                  color: !status.online ? '#b91c1c' : status.gateEnabled ? '#059669' : '#64748b'
                }}>
                  {!status.online ? 'OFFLINE' : status.gateEnabled ? 'ENABLED' : 'DISABLED'}
                </div>
              </div>

              {status.online ? (
                <div style={{ fontSize: '0.8rem' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                    <span style={{ padding: '2px 8px', background: '#f1f5f9', borderRadius: '4px' }}>
                      Cycle: {status.cycleTimeNs ? `${(status.cycleTimeNs / 1000).toFixed(0)} us` : '-'}
                    </span>
                    <span style={{ padding: '2px 8px', background: '#f1f5f9', borderRadius: '4px' }}>
                      GCL: {status.adminControlList?.length || 0} entries
                    </span>
                    {status.configPending && (
                      <span style={{ padding: '2px 8px', background: '#fef3c7', borderRadius: '4px', color: '#92400e' }}>
                        Pending
                      </span>
                    )}
                  </div>
                  {status.adminControlList?.length > 0 && (
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {status.adminControlList.slice(0, 8).map((e, i) => (
                        <span key={i} style={{
                          padding: '2px 4px',
                          background: '#f8fafc',
                          borderRadius: '2px',
                          fontSize: '0.65rem',
                          fontFamily: 'monospace'
                        }}>
                          {e.gateStates}
                        </span>
                      ))}
                    </div>
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

      {/* Configuration */}
      {selectedDevice && (
        <>
          {/* Gate Control List */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Gate Control List</h2>
              <button className="btn btn-secondary" onClick={addEntry} style={{ fontSize: '0.8rem', padding: '6px 12px' }}>
                + Add
              </button>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: '600px', fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '40px' }}>#</th>
                    <th style={{ width: '80px' }}>Time</th>
                    {[7,6,5,4,3,2,1,0].map(tc => <th key={tc} style={{ textAlign: 'center', width: '40px' }}>T{tc}</th>)}
                    <th style={{ width: '50px' }}>Val</th>
                    <th style={{ width: '30px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {gateEntries.map((entry, idx) => (
                    <tr key={idx}>
                      <td style={{ color: '#64748b' }}>{idx + 1}</td>
                      <td>
                        <input
                          type="number"
                          className="form-input"
                          value={entry.timeUs}
                          onChange={(e) => updateEntryTime(idx, e.target.value)}
                          style={{ width: '70px', padding: '4px' }}
                          min="1"
                        />
                      </td>
                      {[7,6,5,4,3,2,1,0].map(tc => (
                        <td key={tc} style={{ textAlign: 'center' }}>
                          <button
                            onClick={() => toggleGate(idx, tc)}
                            style={{
                              width: '28px', height: '28px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                              background: entry.gates[tc] ? '#22c55e' : '#ef4444',
                              color: '#fff', fontWeight: '600', fontSize: '0.7rem'
                            }}
                          >
                            {entry.gates[tc] ? 'O' : 'C'}
                          </button>
                        </td>
                      ))}
                      <td style={{ fontFamily: 'monospace', color: '#64748b' }}>{gatesToInt(entry.gates)}</td>
                      <td>
                        <button
                          onClick={() => removeEntry(idx)}
                          disabled={gateEntries.length <= 1}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: gateEntries.length > 1 ? '#dc2626' : '#ccc' }}
                        >
                          X
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: '8px', fontSize: '0.75rem', color: '#64748b' }}>
              Total: {totalTimeUs} us | O=Open, C=Closed
            </div>
          </div>

          {/* Timing */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Timing</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
              <div>
                <label className="form-label">Gate Enabled</label>
                <select className="form-select" value={gateEnabled} onChange={(e) => setGateEnabled(e.target.value === 'true')}>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
              <div>
                <label className="form-label">Cycle Time (us)</label>
                <input type="number" className="form-input" value={cycleTimeUs} onChange={(e) => setCycleTimeUs(parseInt(e.target.value) || 0)} />
              </div>
              <div>
                <label className="form-label">Extension (us)</label>
                <input type="number" className="form-input" value={cycleTimeExtensionUs} onChange={(e) => setCycleTimeExtensionUs(parseInt(e.target.value) || 0)} />
              </div>
              <div>
                <label className="form-label">Base Time (s)</label>
                <input type="number" className="form-input" value={baseTimeSeconds} onChange={(e) => setBaseTimeSeconds(parseInt(e.target.value) || 0)} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '16px', borderTop: '1px solid #e2e8f0', paddingTop: '16px' }}>
              <button className="btn btn-primary" onClick={applyConfig} disabled={loading}>
                {loading ? 'Applying...' : 'Apply Config'}
              </button>
              <button className="btn btn-secondary" onClick={triggerConfigChange} disabled={loading}>
                Trigger Change
              </button>
              <button className="btn btn-secondary" onClick={() => setCycleTimeUs(totalTimeUs)}>
                Cycle = Total ({totalTimeUs})
              </button>
            </div>
          </div>
        </>
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

export default TAS
