import { createContext, useContext, useState, useEffect } from 'react'

const DeviceContext = createContext()

const STORAGE_KEY = 'tsn-devices'
const STORAGE_VERSION_KEY = 'tsn-devices-version'
const DEVICES_VERSION = 10  // Added board3 for ttyACM2

const defaultDevices = [
  { id: 'board1', name: 'LAN9692 #1', transport: 'serial', device: '/dev/ttyACM0' },
  { id: 'board2', name: 'LAN9692 #2', transport: 'serial', device: '/dev/ttyACM1' },
  { id: 'board3', name: 'LAN9692 #3', transport: 'serial', device: '/dev/ttyACM2' },
]

export function DeviceProvider({ children }) {
  const [devices, setDevicesState] = useState([])
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [initialized, setInitialized] = useState(false)

  // Load devices from localStorage on mount
  useEffect(() => {
    const savedVersion = localStorage.getItem(STORAGE_VERSION_KEY)
    const savedDevices = localStorage.getItem(STORAGE_KEY)

    let loadedDevices = defaultDevices
    if (savedDevices && savedVersion === String(DEVICES_VERSION)) {
      try {
        loadedDevices = JSON.parse(savedDevices)
      } catch {
        loadedDevices = defaultDevices
      }
    }

    setDevicesState(loadedDevices)
    if (loadedDevices.length > 0) {
      setSelectedDevice(loadedDevices[0])
    }
    setInitialized(true)
  }, [])

  // Save devices to localStorage when changed
  useEffect(() => {
    if (initialized && devices.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(devices))
      localStorage.setItem(STORAGE_VERSION_KEY, String(DEVICES_VERSION))
    }
  }, [devices, initialized])

  // Update devices list
  const setDevices = (newDevices) => {
    setDevicesState(newDevices)
    // If selected device was removed, select first available
    if (selectedDevice && !newDevices.find(d => d.id === selectedDevice.id)) {
      setSelectedDevice(newDevices.length > 0 ? newDevices[0] : null)
    }
  }

  // Add a device
  const addDevice = (device) => {
    const newDevices = [...devices, device]
    setDevices(newDevices)
    return device
  }

  // Update a device
  const updateDevice = (id, updates) => {
    const newDevices = devices.map(d => d.id === id ? { ...d, ...updates } : d)
    setDevices(newDevices)
    // Update selected device if it was the one updated
    if (selectedDevice?.id === id) {
      setSelectedDevice({ ...selectedDevice, ...updates })
    }
  }

  // Delete a device
  const deleteDevice = (id) => {
    const newDevices = devices.filter(d => d.id !== id)
    setDevices(newDevices)
  }

  // Select a device by id
  const selectDevice = (deviceOrId) => {
    if (typeof deviceOrId === 'string') {
      const device = devices.find(d => d.id === deviceOrId)
      setSelectedDevice(device || null)
    } else {
      setSelectedDevice(deviceOrId)
    }
  }

  const value = {
    devices,
    selectedDevice,
    initialized,
    setDevices,
    addDevice,
    updateDevice,
    deleteDevice,
    selectDevice,
  }

  return (
    <DeviceContext.Provider value={value}>
      {children}
    </DeviceContext.Provider>
  )
}

export function useDevices() {
  const context = useContext(DeviceContext)
  if (!context) {
    throw new Error('useDevices must be used within a DeviceProvider')
  }
  return context
}
