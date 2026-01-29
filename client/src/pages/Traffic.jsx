import { useState, useEffect, useRef } from 'react'
import axios from 'axios'

function Traffic() {
  const [interfaces, setInterfaces] = useState([])
  const [selectedInterface, setSelectedInterface] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  // Traffic config
  const [config, setConfig] = useState({
    dstMac: 'FA:AE:C9:26:A4:08', // Default: Board 2 Port 8
    srcMac: '',
    vlanId: 0,
    pcp: 0,
    packetSize: 100,
    packetsPerSecond: 100,
    duration: 10,
    count: 0
  })

  // Presets for common destinations
  const macPresets = [
    { label: 'Board 2 Port 8', mac: 'FA:AE:C9:26:A4:08' },
    { label: 'Board 2 Port 9', mac: 'FA:AE:C9:26:A4:09' },
    { label: 'Board 1 Port 8', mac: 'E6:F4:41:C9:57:08' },
    { label: 'Board 1 Port 9', mac: 'E6:F4:41:C9:57:09' },
    { label: 'Broadcast', mac: 'FF:FF:FF:FF:FF:FF' },
    { label: 'gPTP Multicast', mac: '01:80:C2:00:00:0E' }
  ]

  // PCP descriptions
  const pcpDescriptions = [
    'Best Effort (Background)',
    'Best Effort',
    'Excellent Effort',
    'Critical Applications',
    'Video (<100ms)',
    'Voice (<10ms)',
    'Internetwork Control',
    'Network Control'
  ]

  // Polling for status
  const pollRef = useRef(null)

  useEffect(() => {
    fetchInterfaces()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const fetchInterfaces = async () => {
    try {
      const res = await axios.get('/api/traffic/interfaces')
      setInterfaces(res.data)
      // Auto-select first non-loopback interface
      const eth = res.data.find(i => i.name.startsWith('enx') || i.name.startsWith('eth'))
      if (eth) setSelectedInterface(eth.name)
    } catch (err) {
      setError('Failed to load interfaces')
    }
  }

  const fetchStatus = async () => {
    try {
      const res = await axios.get('/api/traffic/status')
      setStatus(res.data)
      // Stop polling if no active generators
      if (res.data.active === 0 && pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    } catch (err) {
      // Ignore
    }
  }

  const startTraffic = async () => {
    if (!selectedInterface) {
      setError('Select an interface')
      return
    }
    if (!config.dstMac) {
      setError('Destination MAC required')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const res = await axios.post('/api/traffic/start', {
        interface: selectedInterface,
        ...config
      })
      setStatus({ active: 1, generators: [{ interface: selectedInterface, running: true, sent: 0, config }] })

      // Start polling
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(fetchStatus, 500)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const stopTraffic = async () => {
    setLoading(true)
    try {
      const res = await axios.post('/api/traffic/stop', {
        interface: selectedInterface
      })
      await fetchStatus()
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const sendSingle = async () => {
    if (!selectedInterface || !config.dstMac) {
      setError('Select interface and destination MAC')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const res = await axios.post('/api/traffic/send', {
        interface: selectedInterface,
        ...config
      })
      setError(null)
      alert(`Packet sent! Size: ${res.data.frameSize} bytes`)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const isRunning = status?.generators?.some(g => g.interface === selectedInterface && g.running)
  const currentGen = status?.generators?.find(g => g.interface === selectedInterface)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Traffic Generator</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          {isRunning ? (
            <button className="btn btn-secondary" onClick={stopTraffic} disabled={loading}>
              Stop
            </button>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={sendSingle} disabled={loading}>
                Send 1
              </button>
              <button className="btn btn-primary" onClick={startTraffic} disabled={loading}>
                Start
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="card" style={{ background: '#fef2f2', border: '1px solid #fecaca', marginBottom: '16px' }}>
          <div style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</div>
        </div>
      )}

      {/* Status */}
      {isRunning && currentGen && (
        <div className="card" style={{ marginBottom: '16px', background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ color: '#15803d', fontWeight: '600' }}>Running on {currentGen.interface}</span>
              <div style={{ fontSize: '0.8rem', color: '#166534', marginTop: '4px' }}>
                Sent: <b>{currentGen.sent?.toLocaleString()}</b> packets
                {currentGen.errors > 0 && <span style={{ color: '#dc2626' }}> | Errors: {currentGen.errors}</span>}
                {' | '}Duration: {((currentGen.duration || 0) / 1000).toFixed(1)}s
              </div>
            </div>
            <div style={{
              width: '12px', height: '12px', borderRadius: '50%',
              background: '#22c55e',
              animation: 'pulse 1s infinite'
            }} />
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {/* Interface & Destination */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Source & Destination</h2>
          </div>

          <div className="form-group">
            <label className="form-label">Interface</label>
            <select
              className="form-select"
              value={selectedInterface}
              onChange={(e) => setSelectedInterface(e.target.value)}
              disabled={isRunning}
            >
              <option value="">Select interface...</option>
              {interfaces.map(iface => (
                <option key={iface.name} value={iface.name}>
                  {iface.name} {iface.addresses[0] ? `(${iface.addresses[0]})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Destination MAC</label>
            <input
              type="text"
              className="form-input"
              value={config.dstMac}
              onChange={(e) => setConfig({ ...config, dstMac: e.target.value })}
              placeholder="XX:XX:XX:XX:XX:XX"
              disabled={isRunning}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' }}>
              {macPresets.map(p => (
                <button
                  key={p.mac}
                  className="btn btn-secondary"
                  style={{ fontSize: '0.7rem', padding: '4px 8px' }}
                  onClick={() => setConfig({ ...config, dstMac: p.mac })}
                  disabled={isRunning}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Source MAC (optional, auto-detect)</label>
            <input
              type="text"
              className="form-input"
              value={config.srcMac}
              onChange={(e) => setConfig({ ...config, srcMac: e.target.value })}
              placeholder="Auto-detect from interface"
              disabled={isRunning}
            />
          </div>
        </div>

        {/* VLAN & QoS */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">VLAN & QoS (802.1Q)</h2>
          </div>

          <div className="form-group">
            <label className="form-label">VLAN ID (0 = untagged)</label>
            <input
              type="number"
              className="form-input"
              value={config.vlanId}
              onChange={(e) => setConfig({ ...config, vlanId: parseInt(e.target.value) || 0 })}
              min="0"
              max="4094"
              disabled={isRunning}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Priority Code Point (PCP): {config.pcp}</label>
            <input
              type="range"
              className="form-input"
              value={config.pcp}
              onChange={(e) => setConfig({ ...config, pcp: parseInt(e.target.value) })}
              min="0"
              max="7"
              disabled={isRunning}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '4px' }}>
              {pcpDescriptions[config.pcp]}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#94a3b8' }}>
              <span>0 (Low)</span>
              <span>7 (High)</span>
            </div>
          </div>

          <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px', fontSize: '0.75rem' }}>
            <div style={{ fontWeight: '600', marginBottom: '4px' }}>Traffic Class Mapping:</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px' }}>
              {[0,1,2,3,4,5,6,7].map(p => (
                <div
                  key={p}
                  style={{
                    padding: '4px',
                    textAlign: 'center',
                    background: p === config.pcp ? '#3b82f6' : '#e2e8f0',
                    color: p === config.pcp ? '#fff' : '#64748b',
                    borderRadius: '4px'
                  }}
                >
                  TC{p}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Packet Config */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Packet Configuration</h2>
          </div>

          <div className="form-group">
            <label className="form-label">Packet Size (bytes)</label>
            <input
              type="number"
              className="form-input"
              value={config.packetSize}
              onChange={(e) => setConfig({ ...config, packetSize: parseInt(e.target.value) || 64 })}
              min="64"
              max="1518"
              disabled={isRunning}
            />
            <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
              {[64, 128, 256, 512, 1024, 1518].map(size => (
                <button
                  key={size}
                  className="btn btn-secondary"
                  style={{ fontSize: '0.7rem', padding: '4px 8px' }}
                  onClick={() => setConfig({ ...config, packetSize: size })}
                  disabled={isRunning}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Packets Per Second</label>
            <input
              type="number"
              className="form-input"
              value={config.packetsPerSecond}
              onChange={(e) => setConfig({ ...config, packetsPerSecond: parseInt(e.target.value) || 100 })}
              min="1"
              max="100000"
              disabled={isRunning}
            />
            <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
              {[10, 100, 1000, 5000, 10000].map(rate => (
                <button
                  key={rate}
                  className="btn btn-secondary"
                  style={{ fontSize: '0.7rem', padding: '4px 8px' }}
                  onClick={() => setConfig({ ...config, packetsPerSecond: rate })}
                  disabled={isRunning}
                >
                  {rate >= 1000 ? `${rate/1000}k` : rate}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Duration & Count */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Duration & Limits</h2>
          </div>

          <div className="form-group">
            <label className="form-label">Duration (seconds, 0 = unlimited)</label>
            <input
              type="number"
              className="form-input"
              value={config.duration}
              onChange={(e) => setConfig({ ...config, duration: parseInt(e.target.value) || 0 })}
              min="0"
              disabled={isRunning}
            />
            <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
              {[1, 5, 10, 30, 60, 0].map(dur => (
                <button
                  key={dur}
                  className="btn btn-secondary"
                  style={{ fontSize: '0.7rem', padding: '4px 8px' }}
                  onClick={() => setConfig({ ...config, duration: dur })}
                  disabled={isRunning}
                >
                  {dur === 0 ? '∞' : `${dur}s`}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Packet Count (0 = use duration)</label>
            <input
              type="number"
              className="form-input"
              value={config.count}
              onChange={(e) => setConfig({ ...config, count: parseInt(e.target.value) || 0 })}
              min="0"
              disabled={isRunning}
            />
          </div>

          <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px', fontSize: '0.8rem' }}>
            <div style={{ fontWeight: '600', marginBottom: '4px' }}>Estimated:</div>
            <div>
              Rate: {((config.packetSize * config.packetsPerSecond * 8) / 1000000).toFixed(2)} Mbps
            </div>
            {config.duration > 0 && (
              <div>
                Total packets: {(config.packetsPerSecond * config.duration).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  )
}

export default Traffic
