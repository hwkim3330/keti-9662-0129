import { useState, useEffect } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

function Settings() {
  const { devices, setDevices, addDevice, updateDevice, deleteDevice, selectedDevice, selectDevice } = useDevices()
  const [serialPorts, setSerialPorts] = useState([])
  const [deviceStatus, setDeviceStatus] = useState({})
  const [checkingAll, setCheckingAll] = useState(false)
  const [editingDevice, setEditingDevice] = useState(null)
  const [hotspot, setHotspot] = useState({ active: false, devices: [] })
  const [scanningHotspot, setScanningHotspot] = useState(false)
  const [togglingHotspot, setTogglingHotspot] = useState(false)

  useEffect(() => {
    fetchSerialPorts()
    scanHotspot()
    autoAddSerialDevices()
  }, [])

  const fetchSerialPorts = async () => {
    try {
      const res = await axios.get('/api/config/ports')
      const filtered = res.data.ports.filter(p =>
        p.path.includes('ttyACM') || p.path.includes('ttyUSB')
      )
      setSerialPorts(filtered)
    } catch (err) {
      console.error('Failed to fetch ports:', err)
    }
  }

  const scanHotspot = async () => {
    setScanningHotspot(true)
    try {
      const res = await axios.get('/api/config/hotspot')
      setHotspot(res.data)
    } catch (err) {
      console.error('Failed to scan hotspot:', err)
    } finally {
      setScanningHotspot(false)
    }
  }

  // Auto-add serial devices if not already added
  const autoAddSerialDevices = async () => {
    try {
      const res = await axios.get('/api/config/ports')
      const acmPorts = res.data.ports.filter(p => p.path.includes('ttyACM'))

      acmPorts.forEach((port, idx) => {
        const exists = devices.some(d => d.device === port.path)
        if (!exists) {
          addDevice({
            id: `serial${Date.now()}_${idx}`,
            name: `LAN9692 #${idx + 1}`,
            transport: 'serial',
            device: port.path
          })
        }
      })
    } catch (err) {
      console.error('Failed to auto-add serial devices:', err)
    }
  }

  // Toggle hotspot on/off
  const toggleHotspot = async () => {
    setTogglingHotspot(true)
    try {
      await axios.post('/api/config/hotspot/toggle')
      setTimeout(scanHotspot, 2000) // Rescan after 2s
    } catch (err) {
      console.error('Failed to toggle hotspot:', err)
      alert('핫스팟 토글 실패: ' + err.message)
    } finally {
      setTogglingHotspot(false)
    }
  }

  const checkDeviceStatus = async (device) => {
    setDeviceStatus(prev => ({ ...prev, [device.id]: { checking: true } }))

    try {
      const res = await axios.post('/api/fetch', {
        paths: ['/ietf-system:system'],
        transport: device.transport,
        device: device.device,
        host: device.host,
        port: device.port || 5683
      }, { timeout: 8000 })

      setDeviceStatus(prev => ({
        ...prev,
        [device.id]: { online: true, checking: false, lastCheck: Date.now() }
      }))
    } catch (err) {
      setDeviceStatus(prev => ({
        ...prev,
        [device.id]: { online: false, checking: false, error: err.message, lastCheck: Date.now() }
      }))
    }
  }

  const checkAllDevices = async () => {
    setCheckingAll(true)
    for (const device of devices) {
      await checkDeviceStatus(device)
      await new Promise(r => setTimeout(r, 500))
    }
    setCheckingAll(false)
  }

  const handleAddDevice = (type) => {
    const newDevice = type === 'serial'
      ? { id: `usb${Date.now()}`, name: 'New USB Board', transport: 'serial', device: '/dev/ttyACM0' }
      : { id: `wifi${Date.now()}`, name: 'New ESP32', transport: 'wifi', host: '10.42.0.', port: 5683 }
    addDevice(newDevice)
    setEditingDevice(newDevice.id)
  }

  const handleDeleteDevice = (id) => {
    deleteDevice(id)
    setDeviceStatus(prev => { const n = {...prev}; delete n[id]; return n })
  }

  const isCurrentDevice = (device) => {
    return selectedDevice?.id === device.id
  }

  const usbDevices = devices.filter(d => d.transport === 'serial')
  const wifiDevices = devices.filter(d => d.transport === 'wifi')

  const DeviceCard = ({ device }) => {
    const status = deviceStatus[device.id] || {}
    const isCurrent = isCurrentDevice(device)
    const isEditing = editingDevice === device.id

    return (
      <div style={{
        padding: '16px',
        background: isCurrent ? '#f1f5f9' : '#fff',
        border: isCurrent ? '2px solid #475569' : status.online ? '1px solid #6ee7b7' : status.online === false ? '1px solid #fca5a5' : '1px solid #e2e8f0',
        borderRadius: '12px',
        position: 'relative'
      }}>
        {/* Status Badge */}
        <div style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          {status.checking ? (
            <span style={{ fontSize: '0.7rem', color: '#64748b' }}>Checking...</span>
          ) : status.online ? (
            <span style={{
              padding: '3px 8px',
              background: '#ecfdf5',
              color: '#047857',
              borderRadius: '6px',
              fontSize: '0.7rem',
              fontWeight: '500'
            }}>ONLINE</span>
          ) : status.online === false ? (
            <span style={{
              padding: '3px 8px',
              background: '#fef2f2',
              color: '#b91c1c',
              borderRadius: '6px',
              fontSize: '0.7rem',
              fontWeight: '500'
            }}>OFFLINE</span>
          ) : (
            <span style={{
              padding: '3px 8px',
              background: '#f8fafc',
              color: '#94a3b8',
              borderRadius: '6px',
              fontSize: '0.7rem'
            }}>-</span>
          )}
        </div>

        {/* Device Icon & Type */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '8px',
            background: device.transport === 'serial' ? '#f5f5f4' : '#f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            {device.transport === 'serial' ? (
              <svg width="18" height="18" fill="none" stroke="#57534e" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            ) : (
              <svg width="18" height="18" fill="none" stroke="#475569" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
              </svg>
            )}
          </div>
          <div>
            <span style={{
              fontSize: '0.65rem',
              padding: '2px 6px',
              background: device.transport === 'serial' ? '#f5f5f4' : '#f1f5f9',
              color: device.transport === 'serial' ? '#57534e' : '#475569',
              borderRadius: '4px',
              fontWeight: '500'
            }}>
              {device.transport === 'serial' ? 'USB' : 'WiFi'}
            </span>
          </div>
        </div>

        {/* Name & Address */}
        {isEditing ? (
          <div style={{ marginBottom: '12px' }}>
            <input
              type="text"
              className="form-input"
              value={device.name}
              onChange={(e) => updateDevice(device.id, { name: e.target.value })}
              style={{ width: '100%', marginBottom: '8px', fontSize: '0.9rem' }}
              placeholder="Device Name"
            />
            {device.transport === 'serial' ? (
              <select
                className="form-select"
                value={device.device}
                onChange={(e) => updateDevice(device.id, { device: e.target.value })}
                style={{ width: '100%', fontSize: '0.85rem' }}
              >
                <option value={device.device}>{device.device}</option>
                {serialPorts.map(p => (
                  <option key={p.path} value={p.path}>{p.path}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="form-input"
                value={device.host}
                onChange={(e) => updateDevice(device.id, { host: e.target.value })}
                style={{ width: '100%', fontSize: '0.85rem' }}
                placeholder="10.42.0.11"
              />
            )}
          </div>
        ) : (
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontWeight: '600', fontSize: '1rem', marginBottom: '4px' }}>{device.name}</div>
            <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', color: '#64748b' }}>
              {device.transport === 'serial' ? device.device : `${device.host}:${device.port}`}
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {isEditing ? (
            <button
              className="btn btn-primary"
              onClick={() => setEditingDevice(null)}
              style={{ flex: 1, fontSize: '0.8rem' }}
            >
              Done
            </button>
          ) : (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => checkDeviceStatus(device)}
                disabled={status.checking}
                style={{ padding: '6px 10px', fontSize: '0.8rem' }}
              >
                {status.checking ? '...' : 'Test'}
              </button>
              <button
                className={`btn ${isCurrent ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => selectDevice(device)}
                style={{ flex: 1, fontSize: '0.8rem' }}
              >
                {isCurrent ? 'Selected' : 'Select'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setEditingDevice(device.id)}
                style={{ padding: '6px 10px', fontSize: '0.8rem' }}
              >
                Edit
              </button>
              <button
                className="btn btn-danger"
                onClick={() => handleDeleteDevice(device.id)}
                style={{ padding: '6px 10px', fontSize: '0.8rem' }}
              >
                Del
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Device Management</h1>
        <button
          className="btn btn-primary"
          onClick={checkAllDevices}
          disabled={checkingAll}
        >
          {checkingAll ? 'Checking...' : 'Test All Connections'}
        </button>
      </div>

      {/* Hotspot Control */}
      <div className="card" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: '16px' }}>
        <div className="card-header">
          <h2 className="card-title">
            WiFi Hotspot {hotspot.active ? `- ${hotspot.hostIP}` : '(OFF)'}
          </h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className={`btn ${hotspot.active ? 'btn-danger' : 'btn-primary'}`}
              onClick={toggleHotspot}
              disabled={togglingHotspot}
              style={{ fontSize: '0.75rem' }}
            >
              {togglingHotspot ? '...' : hotspot.active ? 'Turn OFF' : 'Turn ON'}
            </button>
            {hotspot.active && (
              <button
                className="btn btn-secondary"
                onClick={scanHotspot}
                disabled={scanningHotspot}
                style={{ fontSize: '0.75rem' }}
              >
                {scanningHotspot ? 'Scanning...' : 'Rescan'}
              </button>
            )}
          </div>
        </div>
        {hotspot.active && (
          hotspot.devices.length > 0 ? (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {hotspot.devices.map(dev => {
                const exists = devices.some(d => d.host === dev.ip)
                return (
                  <div key={dev.ip} style={{
                    padding: '8px 12px',
                    background: '#fff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px'
                  }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: '500' }}>{dev.ip}</span>
                    {exists ? (
                      <span style={{ fontSize: '0.7rem', color: '#059669' }}>Saved</span>
                    ) : (
                      <button
                        className="btn btn-primary"
                        style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                        onClick={() => {
                          addDevice({
                            id: `wifi${Date.now()}`,
                            name: `ESP32 (${dev.ip.split('.').pop()})`,
                            transport: 'wifi',
                            host: dev.ip,
                            port: 5683
                          })
                        }}
                      >
                        + Add
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p style={{ color: '#64748b', fontSize: '0.85rem' }}>No devices detected on hotspot</p>
          )
        )}
      </div>

      {/* USB Devices */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">USB Devices</h2>
          <button
            className="btn btn-secondary"
            onClick={() => handleAddDevice('serial')}
            style={{ fontSize: '0.8rem' }}
          >
            + Add USB
          </button>
        </div>
        {usbDevices.length === 0 ? (
          <p style={{ color: '#64748b', textAlign: 'center', padding: '20px' }}>No USB devices configured</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
            {usbDevices.map(device => (
              <DeviceCard key={device.id} device={device} />
            ))}
          </div>
        )}
      </div>

      {/* WiFi Devices */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">WiFi Devices (ESP32)</h2>
          <button
            className="btn btn-secondary"
            onClick={() => handleAddDevice('wifi')}
            style={{ fontSize: '0.8rem' }}
          >
            + Add WiFi
          </button>
        </div>
        {wifiDevices.length === 0 ? (
          <p style={{ color: '#64748b', textAlign: 'center', padding: '20px' }}>No WiFi devices configured</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
            {wifiDevices.map(device => (
              <DeviceCard key={device.id} device={device} />
            ))}
          </div>
        )}
      </div>

      {/* Current Selection Summary */}
      <div className="card" style={{ background: '#f8fafc' }}>
        <div className="card-header">
          <h2 className="card-title">Current Selection</h2>
        </div>
        <div style={{
          padding: '16px',
          background: '#fff',
          borderRadius: '8px',
          border: '1px solid #e2e8f0',
          fontFamily: 'monospace',
          fontSize: '0.9rem'
        }}>
          {selectedDevice ? (
            <>
              <div><strong>Name:</strong> {selectedDevice.name}</div>
              <div><strong>Transport:</strong> {selectedDevice.transport === 'serial' ? 'USB (Serial)' : 'WiFi (UDP)'}</div>
              {selectedDevice.transport === 'serial' ? (
                <div><strong>Device:</strong> {selectedDevice.device}</div>
              ) : (
                <div><strong>Host:</strong> {selectedDevice.host}:{selectedDevice.port}</div>
              )}
            </>
          ) : (
            <div style={{ color: '#94a3b8' }}>No device selected</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Settings
