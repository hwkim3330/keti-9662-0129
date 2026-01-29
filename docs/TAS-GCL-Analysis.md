# TAS (Time-Aware Shaper) GCL Analysis

## Overview

IEEE 802.1Qbv Time-Aware Shaper (TAS) implementation with Gate Control List (GCL) analysis for TSN traffic monitoring.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Traffic     │────▶│ TSN Switch  │────▶│ TAP         │
│ Sender (C)  │     │ (Board 1)   │     │ Interface   │
│ Port: 10000+│     │ Port 8 TAS  │     │ Capture     │
└─────────────┘     └─────────────┘     └─────────────┘
     TX                  TAS                  RX
   (VLAN+PCP)         Scheduling          Analysis
```

## TAS Configuration

### Default Setup (Auto Setup)
- **Cycle Time**: 700ms
- **Slots**: 7 slots (TC1-TC7), each 100ms
- **TC0**: Always open (gate-states includes bit 0 in all slots)
- **Guard Band**: cycle-time-extension (typically 256ns)

### Gate Control List (GCL)
| Slot | Gate States | Open TCs | Duration |
|------|-------------|----------|----------|
| #0   | 0x03 (3)    | TC0, TC1 | 100ms    |
| #1   | 0x05 (5)    | TC0, TC2 | 100ms    |
| #2   | 0x09 (9)    | TC0, TC3 | 100ms    |
| #3   | 0x11 (17)   | TC0, TC4 | 100ms    |
| #4   | 0x21 (33)   | TC0, TC5 | 100ms    |
| #5   | 0x41 (65)   | TC0, TC6 | 100ms    |
| #6   | 0x81 (129)  | TC0, TC7 | 100ms + guard band |

### Guard Band (cycle-time-extension)
- TC7 slot has additional time for frame completion
- Parsed from board: `admin-cycle-time-extension: 256` (256ns)
- TC7 packets may appear at cycle boundary (slot 0 of next cycle)
- GCL analysis accounts for this overflow

## Traffic Classes (TC)

| TC  | PCP | Name   | Description |
|-----|-----|--------|-------------|
| TC0 | 0   | BE(BG) | Best Effort (Background) - Always Open |
| TC1 | 1   | BE     | Best Effort |
| TC2 | 2   | EE     | Excellent Effort |
| TC3 | 3   | CA     | Critical Applications |
| TC4 | 4   | Video  | Video |
| TC5 | 5   | Voice  | Voice |
| TC6 | 6   | IC     | Internetwork Control |
| TC7 | 7   | NC     | Network Control |

## Traffic Sender

### C Implementation (`server/traffic-sender.c`)
High-precision traffic sender with:
- **SCHED_FIFO** real-time scheduling
- **Busy-wait** timing for nanosecond precision
- **Raw sockets** with VLAN tagging
- **mlockall** for memory locking

```bash
# Compile
gcc -O2 -o traffic-sender traffic-sender.c -lpthread

# Run (requires sudo)
sudo ./traffic-sender <interface> <dst-mac> [vlan-id] [tc-list] [pps] [duration]
```

### Packet Format
- Ethernet II frame with 802.1Q VLAN tag
- VLAN ID: 100 (configurable)
- PCP: Maps to TC (0-7)
- Protocol: UDP
- Ports: 10000+TC (src) -> 20000+TC (dst)
- Payload: 10 bytes

## GCL Analysis Algorithm

### 1. Offset Calibration
- Search optimal time offset (0 to cycleTime)
- Score function rewards packets in expected slots
- TC0: small bonus (always open)
- TC1-6: +2 for correct slot
- TC7: +1 for slot 6 or slot 0 (guard band overflow)

### 2. Slot Detection
Uses actual slot boundaries from board configuration:
```javascript
const getSlot = (relTime) => {
  const cyclePos = relTime % cycleTimeMs
  for (let i = 0; i < slotTimes.length; i++) {
    if (cyclePos >= slotTimes[i].startMs && cyclePos < slotTimes[i].endMs) {
      return i
    }
  }
  return slotTimes.length - 1
}
```

### 3. Accuracy Calculation
- **Correct**: TC in expected slot (TC1→slot0, TC2→slot1, etc.)
- **TC7 Exception**: Slot 0 also counts as correct (guard band)
- **Near Correct**: ±1 slot tolerance
- **TC0**: Excluded from accuracy (always open)

### 4. Jitter Analysis
- Deviation from expected slot start time
- 0ms if packet is within expected slot
- Otherwise, distance to nearest slot boundary

## CBS (Credit-Based Shaper) Integration

TAS requires CBS configuration for all TCs to prevent packet drops:
- Each TC needs idle-slope configured
- Default: 100 kbps per TC
- TC0 must be included (often overlooked)

## Troubleshooting

### TC0 Packets Not Received
- **Cause**: CBS not configured for TC0
- **Solution**: Add TC0 to CBS auto setup with idle-slope

### Low GCL Accuracy
- Check traffic sender timing precision (use C sender)
- Verify CBS is configured for all TCs
- Check for network jitter/delays

### TC7 Shows Wrong Slot
- Normal behavior due to guard band
- TC7 may overflow to slot 0 of next cycle
- GCL analysis accounts for this

## API Endpoints

### Traffic Server (port 3001)
```
POST /api/traffic/start-precision
  body: { interface, dstMac, vlanId, tcList, packetsPerSecond, duration }

POST /api/traffic/stop-precision
```

### Main Server (port 3000)
```
POST /api/fetch
  body: { paths: [...], transport, device }

POST /api/patch
  body: { patches: [...], transport, device }

POST /api/capture/start
  body: { interfaces: [...], captureMode }

POST /api/capture/stop
```

## Files

| File | Description |
|------|-------------|
| `client/src/pages/TASDashboard.jsx` | TAS dashboard with GCL analysis |
| `client/src/pages/CBSDashboard.jsx` | CBS configuration dashboard |
| `server/traffic-sender.c` | C traffic sender |
| `server/traffic-server.js` | Traffic API server |
| `server/routes/capture.js` | Packet capture routes |
