import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react'

const CaptureContext = createContext(null)

export function CaptureProvider({ children }) {
  const [capturing, setCapturing] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [activeInterfaces, setActiveInterfaces] = useState([])
  const [wsConnected, setWsConnected] = useState(false)

  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const mountedRef = useRef(true)
  const packetListenersRef = useRef(new Set())

  // Register packet listener (called by Capture page)
  const addPacketListener = useCallback((listener) => {
    packetListenersRef.current.add(listener)
    return () => packetListenersRef.current.delete(listener)
  }, [])

  // Connect WebSocket
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/capture`

    try {
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        if (!mountedRef.current) return
        setWsConnected(true)
        setError(null)
      }

      ws.onmessage = (event) => {
        if (!mountedRef.current) return
        try {
          const msg = JSON.parse(event.data)

          if (msg.type === 'sync') {
            const state = msg.data
            setCapturing(state.running)
            if (state.running) {
              setActiveInterfaces(state.activeCaptures.map(c => c.interface))
              setStatus(`Capturing on: ${state.activeCaptures.map(c => c.interface).join(', ')}`)
            } else {
              setActiveInterfaces([])
              setStatus(null)
            }
          } else if (msg.type === 'packet') {
            // Notify all listeners (Capture page)
            packetListenersRef.current.forEach(listener => listener(msg.data))
          } else if (msg.type === 'stopped') {
            setCapturing(false)
            setActiveInterfaces([])
            setStatus('Capture stopped')
          } else if (msg.type === 'error') {
            setError(msg.message)
            setCapturing(false)
          }
        } catch (e) {
          // Ignore parse errors
        }
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        wsRef.current = null
        setWsConnected(false)

        if (reconnectRef.current) clearTimeout(reconnectRef.current)
        reconnectRef.current = setTimeout(() => {
          if (mountedRef.current) connectWebSocket()
        }, 3000)
      }

      ws.onerror = () => {}

      wsRef.current = ws
    } catch (e) {
      reconnectRef.current = setTimeout(() => {
        if (mountedRef.current) connectWebSocket()
      }, 3000)
    }
  }, [])

  // Connect on mount
  useEffect(() => {
    mountedRef.current = true
    connectWebSocket()

    return () => {
      mountedRef.current = false
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connectWebSocket])

  // Start capture
  const startCapture = useCallback(async (options) => {
    const { interfaces, port = 5683, host = '', captureMode = 'all' } = options

    setError(null)

    try {
      const res = await fetch('/api/capture/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interfaces, port, host, captureMode })
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setCapturing(true)
      setActiveInterfaces(data.started?.map(s => s.interface) || [])
      setStatus(`Capturing on: ${data.started?.map(s => s.interface).join(', ')}`)
      return { success: true, data }
    } catch (err) {
      setError(err.message)
      return { success: false, error: err.message }
    }
  }, [])

  // Stop capture
  const stopCapture = useCallback(async () => {
    try {
      const res = await fetch('/api/capture/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      const data = await res.json()
      setCapturing(false)
      setActiveInterfaces([])
      setStatus('Capture stopped')
      return { success: true, data }
    } catch (err) {
      setError(err.message)
      return { success: false, error: err.message }
    }
  }, [])

  const value = {
    capturing,
    status,
    error,
    activeInterfaces,
    wsConnected,
    startCapture,
    stopCapture,
    addPacketListener,
    setError
  }

  return (
    <CaptureContext.Provider value={value}>
      {children}
    </CaptureContext.Provider>
  )
}

export function useCapture() {
  const context = useContext(CaptureContext)
  if (!context) {
    throw new Error('useCapture must be used within CaptureProvider')
  }
  return context
}
