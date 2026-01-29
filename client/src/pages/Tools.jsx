import { useState } from 'react'
import axios from 'axios'
import { useDevices } from '../contexts/DeviceContext'

function Tools() {
  const { devices, selectedDevice, selectDevice } = useDevices()
  const [activeTab, setActiveTab] = useState('fetch')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  // Fetch tab
  const [fetchPath, setFetchPath] = useState('/ietf-system:system')

  // Patch tab
  const [patchPath, setPatchPath] = useState('')
  const [patchValue, setPatchValue] = useState('')

  // Encode/Decode tab
  const [encodeInput, setEncodeInput] = useState('')
  const [encodeOutput, setEncodeOutput] = useState('')
  const [decodeInput, setDecodeInput] = useState('')
  const [decodeOutput, setDecodeOutput] = useState('')

  // YANG Catalog
  const [catalogs, setCatalogs] = useState([])
  const [selectedCatalog, setSelectedCatalog] = useState(null)
  const [catalogContent, setCatalogContent] = useState('')

  const handleFetch = async () => {
    if (!selectedDevice) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const res = await axios.post('/api/fetch', {
        paths: [fetchPath],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 15000 })
      setResult(res.data.result)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const handlePatch = async () => {
    if (!selectedDevice || !patchPath) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      let value = null
      if (patchValue.trim()) {
        try {
          value = JSON.parse(patchValue)
        } catch {
          // Try YAML-like parsing
          value = patchValue
        }
      }

      const res = await axios.post('/api/patch', {
        patches: [{ path: patchPath, value }],
        transport: selectedDevice.transport,
        device: selectedDevice.device,
        host: selectedDevice.host,
        port: selectedDevice.port || 5683
      }, { timeout: 15000 })
      setResult(JSON.stringify(res.data, null, 2))
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleEncode = async () => {
    if (!encodeInput.trim()) return
    setLoading(true)
    setError(null)

    try {
      const res = await axios.post('/api/encode', { yaml: encodeInput })
      setEncodeOutput(res.data.hex || '')
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDecode = async () => {
    if (!decodeInput.trim()) return
    setLoading(true)
    setError(null)

    try {
      const res = await axios.post('/api/decode', { hex: decodeInput })
      setDecodeOutput(res.data.yaml || '')
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const loadCatalogs = async () => {
    try {
      const res = await axios.get('/api/list')
      setCatalogs(res.data.catalogs || [])
    } catch (err) {
      setError(err.message)
    }
  }

  const loadCatalogContent = async (name) => {
    setSelectedCatalog(name)
    try {
      const res = await axios.get(`/api/catalog/${name}`)
      setCatalogContent(res.data.content || '')
    } catch (err) {
      setCatalogContent(`Error: ${err.message}`)
    }
  }

  const tabs = [
    { id: 'fetch', label: 'Fetch' },
    { id: 'patch', label: 'Patch' },
    { id: 'encode', label: 'Encode' },
    { id: 'decode', label: 'Decode' },
    { id: 'catalog', label: 'YANG Catalog' }
  ]

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">CLI Tools</h1>
        {/* Device Selector */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Device:</span>
          <select
            className="form-select"
            value={selectedDevice?.id || ''}
            onChange={(e) => selectDevice(e.target.value)}
            style={{ minWidth: '120px' }}
          >
            {devices.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid #e2e8f0', paddingBottom: '8px' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); setResult(null); setError(null); if (tab.id === 'catalog') loadCatalogs(); }}
            style={{
              padding: '8px 16px',
              background: activeTab === tab.id ? '#1e293b' : 'transparent',
              color: activeTab === tab.id ? '#fff' : '#64748b',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.85rem',
              fontWeight: activeTab === tab.id ? '600' : '400'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Fetch Tab */}
      {activeTab === 'fetch' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Fetch Data</h2>
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label className="form-label">YANG Path</label>
            <input
              type="text"
              className="form-input"
              value={fetchPath}
              onChange={(e) => setFetchPath(e.target.value)}
              placeholder="/ietf-interfaces:interfaces"
            />
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <button className="btn btn-primary" onClick={handleFetch} disabled={loading || !selectedDevice}>
              {loading ? 'Fetching...' : 'Fetch'}
            </button>
            <button className="btn btn-secondary" onClick={() => setFetchPath('/ietf-system:system')}>System</button>
            <button className="btn btn-secondary" onClick={() => setFetchPath('/ietf-interfaces:interfaces')}>Interfaces</button>
            <button className="btn btn-secondary" onClick={() => setFetchPath('/ieee1588-ptp:ptp/instances')}>PTP</button>
            <button className="btn btn-secondary" onClick={() => setFetchPath('/ietf-hardware:hardware')}>Hardware</button>
          </div>
        </div>
      )}

      {/* Patch Tab */}
      {activeTab === 'patch' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Patch Data</h2>
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label className="form-label">YANG Path</label>
            <input
              type="text"
              className="form-input"
              value={patchPath}
              onChange={(e) => setPatchPath(e.target.value)}
              placeholder="/ietf-interfaces:interfaces/interface[name='1']/enabled"
            />
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label className="form-label">Value (JSON or leave empty for delete)</label>
            <textarea
              className="form-input"
              value={patchValue}
              onChange={(e) => setPatchValue(e.target.value)}
              placeholder='{"enabled": true}'
              rows={4}
              style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
            />
          </div>
          <button className="btn btn-primary" onClick={handlePatch} disabled={loading || !selectedDevice || !patchPath}>
            {loading ? 'Patching...' : 'Patch'}
          </button>
        </div>
      )}

      {/* Encode Tab */}
      {activeTab === 'encode' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">YAML to CBOR (Encode)</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div>
              <label className="form-label">YAML Input</label>
              <textarea
                className="form-input"
                value={encodeInput}
                onChange={(e) => setEncodeInput(e.target.value)}
                placeholder="- ? '/path'\n  : key: value"
                rows={10}
                style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
              />
            </div>
            <div>
              <label className="form-label">CBOR Hex Output</label>
              <textarea
                className="form-input"
                value={encodeOutput}
                readOnly
                rows={10}
                style={{ fontFamily: 'monospace', fontSize: '0.8rem', background: '#f8fafc' }}
              />
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleEncode} disabled={loading} style={{ marginTop: '12px' }}>
            {loading ? 'Encoding...' : 'Encode'}
          </button>
        </div>
      )}

      {/* Decode Tab */}
      {activeTab === 'decode' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">CBOR to YAML (Decode)</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div>
              <label className="form-label">CBOR Hex Input</label>
              <textarea
                className="form-input"
                value={decodeInput}
                onChange={(e) => setDecodeInput(e.target.value)}
                placeholder="a1 6b 2f 69 65..."
                rows={10}
                style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
              />
            </div>
            <div>
              <label className="form-label">YAML Output</label>
              <textarea
                className="form-input"
                value={decodeOutput}
                readOnly
                rows={10}
                style={{ fontFamily: 'monospace', fontSize: '0.8rem', background: '#f8fafc' }}
              />
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleDecode} disabled={loading} style={{ marginTop: '12px' }}>
            {loading ? 'Decoding...' : 'Decode'}
          </button>
        </div>
      )}

      {/* YANG Catalog Tab */}
      {activeTab === 'catalog' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">YANG Catalog</h2>
            <button className="btn btn-secondary" onClick={loadCatalogs}>Refresh</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '16px' }}>
            <div style={{ borderRight: '1px solid #e2e8f0', paddingRight: '16px', maxHeight: '400px', overflow: 'auto' }}>
              {catalogs.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: '0.85rem' }}>No catalogs. Click Refresh.</div>
              ) : (
                catalogs.map(cat => (
                  <div
                    key={cat}
                    onClick={() => loadCatalogContent(cat)}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      borderRadius: '6px',
                      marginBottom: '4px',
                      background: selectedCatalog === cat ? '#f1f5f9' : 'transparent',
                      fontSize: '0.8rem',
                      fontFamily: 'monospace'
                    }}
                  >
                    {cat}
                  </div>
                ))
              )}
            </div>
            <div>
              {selectedCatalog ? (
                <>
                  <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '8px' }}>{selectedCatalog}</div>
                  <pre style={{
                    background: '#f8fafc',
                    padding: '12px',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    maxHeight: '350px',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap'
                  }}>
                    {catalogContent}
                  </pre>
                </>
              ) : (
                <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Select a catalog</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && <div className="alert alert-error" style={{ marginTop: '16px' }}>{error}</div>}

      {/* Result */}
      {result && (
        <div className="card" style={{ marginTop: '16px' }}>
          <div className="card-header">
            <h2 className="card-title">Result</h2>
            <button className="btn btn-secondary" onClick={() => setResult(null)} style={{ fontSize: '0.75rem', padding: '4px 8px' }}>Clear</button>
          </div>
          <pre style={{
            background: '#f8fafc',
            padding: '12px',
            borderRadius: '6px',
            fontSize: '0.8rem',
            maxHeight: '400px',
            overflow: 'auto',
            whiteSpace: 'pre-wrap'
          }}>
            {result}
          </pre>
        </div>
      )}
    </div>
  )
}

export default Tools
