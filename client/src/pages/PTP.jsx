import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

function PTP() {
  const { devices, selectedDevice, selectDevice } = useDevices()
  const [deviceStatuses, setDeviceStatuses] = useState({})

  // Configuration state
  const [profile, setProfile] = useState('bridge')
  const [portRoles, setPortRoles] = useState(() => {
    const roles = {}
    for (let i = 1; i <= 12; i++) roles[i] = 'disabled'
    roles[8] = 'master'
    return roles
  })
  const [enable1PPS, setEnable1PPS] = useState(true)
  const [enableServo, setEnableServo] = useState(true)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastResult, setLastResult] = useState(null)

  // Auto refresh
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef(null)
  const fetchingRef = useRef(false)


  // Parse detailed status from YAML
  const parseStatus = (yamlStr) => {
    if (!yamlStr || yamlStr.includes('instance: null')) return null
    try {
      const status = {
        profile: 'none',
        ports: [],
        servo: null,
        pps: null,
        clockIdentity: null,
        grandmasterIdentity: null,
        isGrandmaster: false,
        servoOffset: null,
        servoState: null,
        parentClockIdentity: null,
        parentPortNumber: null
      }

      const profileMatch = yamlStr.match(/profile:\s*(\w+)/)
      if (profileMatch) status.profile = profileMatch[1]

      const clockIdMatch = yamlStr.match(/clock-identity:\s*([\w-]+)/)
      if (clockIdMatch) status.clockIdentity = clockIdMatch[1]

      const gmIdMatch = yamlStr.match(/grandmaster-identity:\s*([\w-]+)/)
      if (gmIdMatch) status.grandmasterIdentity = gmIdMatch[1]

      // Note: isGrandmaster is set later based on parent-port-identity

      const parentSection = yamlStr.match(/parent-port-identity:[\s\S]*?clock-identity:\s*([\w-]+)[\s\S]*?port-number:\s*(\d+)/)
      if (parentSection) {
        status.parentClockIdentity = parentSection[1]
        status.parentPortNumber = parseInt(parentSection[2])
      }

      // Determine GM status: true if parent clock is 00-00-00-00-00-00-00-00 or same as self
      if (status.parentClockIdentity) {
        const isParentNull = status.parentClockIdentity === '00-00-00-00-00-00-00-00'
        const isParentSelf = status.parentClockIdentity === status.clockIdentity
        status.isGrandmaster = isParentNull || isParentSelf
      }

      // Parse port entries - look for port-index followed by port info
      const portRegex = /port-index:\s*(\d+)[\s\S]*?port-state:\s*(\w+)[\s\S]*?(?:mean-link-delay:\s*(\d+))?[\s\S]*?(?:as-capable:\s*(\w+))?/g
      let portMatch
      while ((portMatch = portRegex.exec(yamlStr)) !== null) {
        status.ports.push({
          index: parseInt(portMatch[1]),
          state: portMatch[2],
          meanLinkDelay: portMatch[3] ? parseInt(portMatch[3]) : null,
          asCapable: portMatch[4] ? portMatch[4] === 'true' : null
        })
      }

      // If regex didn't work, try simpler approach
      if (status.ports.length === 0) {
        const simplePortMatch = yamlStr.match(/port-index:\s*(\d+)[\s\S]*?port-state:\s*(\w+)/g)
        if (simplePortMatch) {
          for (const match of simplePortMatch) {
            const idx = match.match(/port-index:\s*(\d+)/)
            const st = match.match(/port-state:\s*(\w+)/)
            if (idx && st) {
              status.ports.push({ index: parseInt(idx[1]), state: st[1] })
            }
          }
        }
      }

      const servoOffsetMatch = yamlStr.match(/servo:[\s\S]*?offset:\s*(-?\d+)/)
      const servoStateMatch = yamlStr.match(/servo:[\s\S]*?state:\s*(\d+)/)
      if (servoOffsetMatch) status.servoOffset = parseInt(servoOffsetMatch[1])
      if (servoStateMatch) status.servoState = parseInt(servoStateMatch[1])

      if (yamlStr.includes('servo-index:')) status.servo = true
      if (yamlStr.includes('1pps-out')) status.pps = true

      return status
    } catch {
      return null
    }
  }

  // Fetch status for a single device
  const fetchDeviceStatus = async (device, silent = false) => {
    try {
      const res = await axios.post('/api/fetch', {
        paths: ['/ieee1588-ptp:ptp'],
        transport: device.transport,
        device: device.device,
        host: device.host,
        port: device.port || 5683
      }, { timeout: 8000 })

      const parsed = parseStatus(res.data.result)
      return { ...parsed, online: true, error: null }
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
        const status = await fetchDeviceStatus(device, silent)
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

  // Apply configuration
  const apply = async () => {
    if (!selectedDevice) return
    setLoading(true)
    setError(null)
    setLastResult(null)

    const portList = []
    for (let i = 1; i <= 12; i++) {
      if (portRoles[i] !== 'disabled') {
        portList.push({
          'port-index': i,
          'external-port-config-port-ds': { 'desired-state': portRoles[i] }
        })
      }
    }

    const patches = []

    const instance = {
      'instance-index': 0,
      'default-ds': { 'external-port-config-enable': true },
      'mchp-velocitysp-ptp:automotive': { profile },
      ports: { port: portList }
    }
    if (enableServo) {
      instance['mchp-velocitysp-ptp:servos'] = {
        servo: [{ 'servo-index': 0, 'servo-type': 'pi', 'ltc-index': 0 }]
      }
    }
    patches.push({ path: '/ieee1588-ptp:ptp/instances/instance', value: instance })

    if (enable1PPS) {
      patches.push({
        path: '/ieee1588-ptp:ptp/mchp-velocitysp-ptp:ltcs/ltc',
        value: {
          'ltc-index': 0,
          'ptp-pins': { 'ptp-pin': [{ index: 4, function: '1pps-out' }] }
        }
      })
    }

    try {
      const res = await axios.post('/api/patch', {
        patches,
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      })
      setLastResult(res.data)
      if (res.data?.summary?.failed === 0) {
        setTimeout(() => fetchAllStatuses(true), 500)
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  // Reset configuration
  const reset = async () => {
    if (!selectedDevice) return
    if (!confirm('PTP 설정을 초기화하시겠습니까?')) return
    setLoading(true)
    try {
      await axios.post('/api/patch', {
        patches: [
          { path: "/ieee1588-ptp:ptp/instances/instance[instance-index='0']", value: null },
          { path: "/ieee1588-ptp:ptp/mchp-velocitysp-ptp:ltcs/ltc[ltc-index='0']", value: null }
        ],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      })
      setLastResult({ reset: true })
      fetchAllStatuses(true)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  // Initial fetch
  useEffect(() => {
    if (devices.length > 0) {
      fetchAllStatuses(false)
    }
  }, [devices])

  // Auto refresh effect
  useEffect(() => {
    if (autoRefresh && devices.length > 0) {
      intervalRef.current = setInterval(() => fetchAllStatuses(true), 3000)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh, devices])

  // Format nanoseconds
  const formatNs = (ns) => {
    if (ns === null || ns === undefined) return '-'
    if (Math.abs(ns) < 1000) return `${ns} ns`
    if (Math.abs(ns) < 1000000) return `${(ns / 1000).toFixed(1)} us`
    return `${(ns / 1000000).toFixed(2)} ms`
  }

  // Servo state to text
  const servoStateText = (state) => {
    const states = { 0: 'Init', 1: 'Tracking', 2: 'Locked', 3: 'Holdover' }
    return states[state] || '-'
  }

  const getPortBg = (role) => {
    if (role === 'master') return '#f1f5f9'
    if (role === 'slave') return '#f5f5f4'
    if (role === 'passive') return '#fafafa'
    return '#f8fafc'
  }

  // Auto Setup state
  const [autoSetupConfig, setAutoSetupConfig] = useState({
    gmDevice: 'board1',
    gmPort: 10,
    slaveDevice: 'board3',
    slavePort: 8,
    autoSlave: true  // Use BMCA for automatic slave selection
  })
  const [showAutoSetup, setShowAutoSetup] = useState(false)

  // Quick setup - configure GM and Slave with configurable ports
  const quickSetup = async () => {
    const gmBoard = devices.find(d => d.id === autoSetupConfig.gmDevice)
    const slaveBoard = devices.find(d => d.id === autoSetupConfig.slaveDevice)

    if (!gmBoard) {
      setError('GM device not found')
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Configure GM board
      await axios.post('/api/patch', {
        patches: [
          {
            path: '/ieee1588-ptp:ptp/instances/instance',
            value: {
              'instance-index': 0,
              'default-ds': { 'external-port-config-enable': true },
              'mchp-velocitysp-ptp:automotive': { profile: 'gm' },
              ports: { port: [{ 'port-index': autoSetupConfig.gmPort, 'external-port-config-port-ds': { 'desired-state': 'master' } }] },
              'mchp-velocitysp-ptp:servos': { servo: [{ 'servo-index': 0, 'servo-type': 'pi', 'ltc-index': 0 }] }
            }
          },
          {
            path: '/ieee1588-ptp:ptp/mchp-velocitysp-ptp:ltcs/ltc',
            value: { 'ltc-index': 0, 'ptp-pins': { 'ptp-pin': [{ index: 4, function: '1pps-out' }] } }
          }
        ],
        transport: gmBoard.transport,
        device: gmBoard.device,
        host: gmBoard.host,
        port: gmBoard.port || 5683
      })

      // Configure Slave board if selected
      if (slaveBoard) {
        const slaveDesiredState = autoSetupConfig.autoSlave ? 'slave' : 'slave'
        await axios.post('/api/patch', {
          patches: [
            {
              path: '/ieee1588-ptp:ptp/instances/instance',
              value: {
                'instance-index': 0,
                'default-ds': { 'external-port-config-enable': !autoSetupConfig.autoSlave },
                'mchp-velocitysp-ptp:automotive': { profile: 'bridge' },
                ports: { port: [{ 'port-index': autoSetupConfig.slavePort, 'external-port-config-port-ds': { 'desired-state': slaveDesiredState } }] },
                'mchp-velocitysp-ptp:servos': { servo: [{ 'servo-index': 0, 'servo-type': 'pi', 'ltc-index': 0 }] }
              }
            },
            {
              path: '/ieee1588-ptp:ptp/mchp-velocitysp-ptp:ltcs/ltc',
              value: { 'ltc-index': 0, 'ptp-pins': { 'ptp-pin': [{ index: 4, function: '1pps-out' }] } }
            }
          ],
          transport: slaveBoard.transport,
          device: slaveBoard.device,
          host: slaveBoard.host,
          port: slaveBoard.port || 5683
        })
      }

      setLastResult({
        quickSetup: true,
        gm: `${gmBoard.name} (P${autoSetupConfig.gmPort})`,
        slave: slaveBoard ? `${slaveBoard.name} (P${autoSetupConfig.slavePort})` : 'None'
      })
      setShowAutoSetup(false)
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
        <h1 className="page-title">PTP (802.1AS)</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto (3s)
          </label>
          <button className="btn btn-secondary" onClick={() => fetchAllStatuses(false)} disabled={loading}>
            Refresh
          </button>
          <button className="btn btn-primary" onClick={() => setShowAutoSetup(true)} disabled={loading || devices.length < 1}>
            Auto Setup
          </button>
        </div>
      </div>

      {/* Auto Setup Dialog */}
      {showAutoSetup && (
        <div className="card" style={{ marginBottom: '16px', border: '2px solid #475569' }}>
          <div className="card-header">
            <h2 className="card-title">Auto Setup - PTP Configuration</h2>
            <button className="btn btn-secondary" onClick={() => setShowAutoSetup(false)} style={{ padding: '4px 12px' }}>
              ✕
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            {/* GM Configuration */}
            <div style={{ padding: '16px', background: '#f5f5f4', borderRadius: '8px' }}>
              <div style={{ fontWeight: '600', marginBottom: '12px', color: '#57534e' }}>Grandmaster (GM)</div>
              <div style={{ marginBottom: '12px' }}>
                <label className="form-label">Device</label>
                <select
                  className="form-select"
                  value={autoSetupConfig.gmDevice}
                  onChange={(e) => setAutoSetupConfig(prev => ({ ...prev, gmDevice: e.target.value }))}
                >
                  {devices.map(d => (
                    <option key={d.id} value={d.id}>{d.name} ({d.device || d.host})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label">Master Port</label>
                <select
                  className="form-select"
                  value={autoSetupConfig.gmPort}
                  onChange={(e) => setAutoSetupConfig(prev => ({ ...prev, gmPort: parseInt(e.target.value) }))}
                >
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map(n => (
                    <option key={n} value={n}>Port {n}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Slave Configuration */}
            <div style={{ padding: '16px', background: '#f1f5f9', borderRadius: '8px' }}>
              <div style={{ fontWeight: '600', marginBottom: '12px', color: '#475569' }}>Slave</div>
              <div style={{ marginBottom: '12px' }}>
                <label className="form-label">Device</label>
                <select
                  className="form-select"
                  value={autoSetupConfig.slaveDevice}
                  onChange={(e) => setAutoSetupConfig(prev => ({ ...prev, slaveDevice: e.target.value }))}
                >
                  <option value="">-- None --</option>
                  {devices.filter(d => d.id !== autoSetupConfig.gmDevice).map(d => (
                    <option key={d.id} value={d.id}>{d.name} ({d.device || d.host})</option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label className="form-label">Slave Port</label>
                <select
                  className="form-select"
                  value={autoSetupConfig.slavePort}
                  onChange={(e) => setAutoSetupConfig(prev => ({ ...prev, slavePort: parseInt(e.target.value) }))}
                >
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map(n => (
                    <option key={n} value={n}>Port {n}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={autoSetupConfig.autoSlave}
                    onChange={(e) => setAutoSetupConfig(prev => ({ ...prev, autoSlave: e.target.checked }))}
                  />
                  <span style={{ fontSize: '0.85rem' }}>BMCA Auto (external-port-config disabled)</span>
                </label>
              </div>
            </div>
          </div>

          {/* Connection Info */}
          <div style={{ marginTop: '16px', padding: '12px', background: '#f8fafc', borderRadius: '8px', fontSize: '0.85rem' }}>
            <strong>Connection:</strong>{' '}
            {devices.find(d => d.id === autoSetupConfig.gmDevice)?.name || '-'} (P{autoSetupConfig.gmPort})
            {' → '}
            {autoSetupConfig.slaveDevice ? `${devices.find(d => d.id === autoSetupConfig.slaveDevice)?.name || '-'} (P${autoSetupConfig.slavePort})` : 'None'}
          </div>

          {/* Actions */}
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setShowAutoSetup(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={quickSetup} disabled={loading}>
              {loading ? 'Applying...' : 'Apply Setup'}
            </button>
          </div>
        </div>
      )}

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
              {/* Header */}
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
                  background: !status.online ? '#fef2f2' : status.isGrandmaster ? '#f5f5f4' : '#f1f5f9',
                  color: !status.online ? '#b91c1c' : status.isGrandmaster ? '#57534e' : '#475569'
                }}>
                  {!status.online ? 'OFFLINE' : status.isGrandmaster ? 'GM' : 'SLAVE'}
                </div>
              </div>

              {status.online ? (
                <>
                  {/* Offset Display */}
                  <div style={{
                    padding: '12px',
                    background: '#f8fafc',
                    borderRadius: '8px',
                    textAlign: 'center',
                    marginBottom: '10px'
                  }}>
                    <div style={{ fontSize: '0.65rem', color: '#64748b' }}>
                      {status.isGrandmaster ? 'Reference' : 'Offset'}
                    </div>
                    <div style={{
                      fontSize: '1.5rem',
                      fontWeight: '700',
                      fontFamily: 'monospace',
                      color: '#334155'
                    }}>
                      {status.isGrandmaster ? '0 ns' : (status.servoOffset !== null ? `${status.servoOffset} ns` : '-')}
                    </div>
                    {!status.isGrandmaster && status.servoState !== null && (
                      <div style={{ fontSize: '0.7rem', color: status.servoState === 1 ? '#059669' : '#64748b' }}>
                        {servoStateText(status.servoState)}
                      </div>
                    )}
                  </div>

                  {/* Port & Profile Info */}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '0.7rem' }}>
                    <span style={{ padding: '2px 6px', background: '#f1f5f9', borderRadius: '4px' }}>
                      {status.profile || '-'}
                    </span>
                    {status.ports.map(p => (
                      <span key={p.index} style={{ padding: '2px 6px', background: '#f1f5f9', borderRadius: '4px' }}>
                        P{p.index}:{p.state[0]}
                      </span>
                    ))}
                    {status.pps && (
                      <span style={{ padding: '2px 6px', background: '#ecfdf5', borderRadius: '4px', color: '#059669' }}>
                        1PPS
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
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

      {/* Configuration - for selected device */}
      {selectedDevice && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Configure: {selectedDevice.name}</h2>
          </div>

          {/* Profile & Options */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
            <div>
              <label className="form-label">Profile</label>
              <select className="form-select" value={profile} onChange={(e) => setProfile(e.target.value)}>
                <option value="gm">Grandmaster</option>
                <option value="bridge">Bridge (Slave)</option>
                <option value="none">Standard</option>
              </select>
            </div>
            <div>
              <label className="form-label">Options</label>
              <div style={{ display: 'flex', gap: '20px', marginTop: '8px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={enableServo} onChange={(e) => setEnableServo(e.target.checked)} />
                  Servo
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={enable1PPS} onChange={(e) => setEnable1PPS(e.target.checked)} />
                  1PPS Output
                </label>
              </div>
            </div>
          </div>

          {/* Ports */}
          <div style={{ marginBottom: '20px' }}>
            <label className="form-label">Ports</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '8px' }}>
              {[1,2,3,4,5,6,7,8,9,10,11,12].map(n => (
                <div key={n}>
                  <div style={{ fontSize: '0.7rem', color: '#64748b', marginBottom: '2px' }}>P{n}</div>
                  <select
                    className="form-select"
                    value={portRoles[n]}
                    onChange={(e) => setPortRoles(prev => ({ ...prev, [n]: e.target.value }))}
                    style={{ padding: '6px', fontSize: '0.8rem', background: getPortBg(portRoles[n]) }}
                  >
                    <option value="disabled">-</option>
                    <option value="master">M</option>
                    <option value="slave">S</option>
                    <option value="passive">P</option>
                  </select>
                </div>
              ))}
            </div>
            <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '4px' }}>
              M=Master, S=Slave, P=Passive, -=Disabled
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', borderTop: '1px solid #e2e8f0', paddingTop: '16px' }}>
            <button className="btn btn-danger" onClick={reset} disabled={loading}>Reset</button>
            <button className="btn btn-primary" onClick={apply} disabled={loading}>
              {loading ? 'Applying...' : 'Apply'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {lastResult && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Result</h2>
          </div>
          {lastResult.reset ? (
            <div style={{ color: '#16a34a' }}>Configuration reset</div>
          ) : lastResult.quickSetup ? (
            <div style={{ color: '#16a34a' }}>
              Auto Setup complete: GM={lastResult.gm} → Slave={lastResult.slave}
            </div>
          ) : (
            <div>
              {lastResult.results?.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: '8px', padding: '4px 0', fontSize: '0.85rem' }}>
                  <span style={{ color: r.success ? '#16a34a' : '#dc2626' }}>{r.success ? 'OK' : 'Fail'}</span>
                  <span>{r.path.split('/').pop()}</span>
                  {r.error && <span style={{ color: '#dc2626', fontSize: '0.75rem' }}>- {r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default PTP
