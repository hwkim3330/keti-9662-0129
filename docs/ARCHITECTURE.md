# System Architecture

KETI TSN Switch Manager 시스템 아키텍처 문서

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Browser                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     React SPA (Vite Build)                            │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │  │
│  │  │ Dashboards  │  │Configuration│  │   Tools     │  │  Contexts  │  │  │
│  │  │ PTP/TAS/CBS │  │ PTP/TAS/CBS │  │ Ports/Capture│  │Device/Capture│ │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                     ┌───────────┴───────────┐
                     │    HTTP REST API      │
                     │    WebSocket (ws)     │
                     └───────────┬───────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────────┐
│                         Node.js Server (Express)                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         API Routes Layer                              │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │  │
│  │  │  /ptp   │ │/capture │ │/traffic │ │ /fetch  │ │ /patch  │        │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Service Layer                                  │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │  │
│  │  │   tsc2cbor      │  │    libpcap      │  │   WebSocket     │      │  │
│  │  │  YANG↔CBOR      │  │ Packet Capture  │  │   Broadcast     │      │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘      │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                     ┌───────────┴───────────┐
                     │    CoAP over UDP      │
                     │    Port 5683          │
                     └───────────┬───────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────────┐
│                          ESP32 WiFi Proxy                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  WiFi AP/STA ──► CoAP Server ──► MUP1 Protocol ──► UART TX/RX        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                     ┌───────────┴───────────┐
                     │    Serial UART        │
                     │    115200 baud        │
                     └───────────┬───────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────────┐
│                        LAN9692 TSN Switch                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Management CPU                                 │  │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐         │  │
│  │  │MUP1 Parser│  │YANG Engine│  │CBOR Codec │  │Config Store│         │  │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘         │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Switch ASIC                                    │  │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐         │  │
│  │  │gPTP Engine│  │TAS (Qbv)  │  │CBS (Qav)  │  │Port Control│         │  │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘         │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Port 1  │  Port 2  │  Port 3  │  ...  │  Port 11  │  Port 12       │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Communication Protocols

### 1. CoAP (Constrained Application Protocol)

ESP32와 통신에 사용되는 경량 REST 프로토콜

```
┌─────────────┐        CoAP/UDP        ┌─────────────┐
│   Server    │ ◄─────────────────────► │   ESP32     │
│  (Node.js)  │       Port 5683         │   Proxy     │
└─────────────┘                         └─────────────┘

Message Types:
- CON (Confirmable): 신뢰성 보장
- NON (Non-confirmable): Fire-and-forget
- ACK (Acknowledgement)
- RST (Reset)

Method Codes:
- FETCH (5): 데이터 조회 (iFETCH)
- iPATCH (7): 데이터 수정
- POST (2): RPC 호출
```

### 2. MUP1 (Microchip Unified Protocol v1)

ESP32와 LAN9692 간 시리얼 통신 프로토콜

```
┌─────────────┐       MUP1/UART        ┌─────────────┐
│   ESP32     │ ◄─────────────────────► │  LAN9692    │
│   Proxy     │       115200 baud       │   Switch    │
└─────────────┘                         └─────────────┘

Frame Structure:
┌──────┬────────┬──────────┬─────────┬─────────┐
│ SOF  │ Length │ Msg Type │ Payload │ CRC16   │
│ 0x7E │ 2 bytes│ 1 byte   │ N bytes │ 2 bytes │
└──────┴────────┴──────────┴─────────┴─────────┘
```

### 3. CBOR (Concise Binary Object Representation)

YANG 데이터 인코딩에 사용

```
YAML (Human-readable)          CBOR (Binary)
─────────────────────          ─────────────
ieee1588-ptp:ptp:       ──►    a1 19 52 0b a1 ...
  instances:
    instance:
      - instance-index: 0
        offset: -15

SID (Schema Item ID) 기반 압축 인코딩
- 전체 경로 대신 정수 ID 사용
- Delta 인코딩으로 추가 압축
```

---

## Data Flow

### 1. 설정 조회 (iFETCH)

```
Browser                 Server                  ESP32                 LAN9692
   │                       │                       │                       │
   │  GET /api/ptp/offset  │                       │                       │
   │──────────────────────►│                       │                       │
   │                       │  CoAP FETCH           │                       │
   │                       │──────────────────────►│                       │
   │                       │                       │  MUP1 Request         │
   │                       │                       │──────────────────────►│
   │                       │                       │                       │
   │                       │                       │  MUP1 Response (CBOR) │
   │                       │                       │◄──────────────────────│
   │                       │  CoAP 2.05 Content    │                       │
   │                       │◄──────────────────────│                       │
   │                       │                       │                       │
   │  JSON { offset: -15 } │  ◄── CBOR→YAML        │                       │
   │◄──────────────────────│      Decode           │                       │
```

### 2. 설정 변경 (iPATCH)

```
Browser                 Server                  ESP32                 LAN9692
   │                       │                       │                       │
   │  POST /api/patch      │                       │                       │
   │  { yaml: "..." }      │                       │                       │
   │──────────────────────►│                       │                       │
   │                       │  YAML→CBOR Encode     │                       │
   │                       │          │            │                       │
   │                       │  CoAP iPATCH          │                       │
   │                       │──────────────────────►│                       │
   │                       │                       │  MUP1 Request         │
   │                       │                       │──────────────────────►│
   │                       │                       │                       │
   │                       │                       │  MUP1 ACK             │
   │                       │                       │◄──────────────────────│
   │                       │  CoAP 2.04 Changed    │                       │
   │                       │◄──────────────────────│                       │
   │                       │                       │                       │
   │  { success: true }    │                       │                       │
   │◄──────────────────────│                       │                       │
```

### 3. 실시간 패킷 캡처

```
TAP Device              Server                  Browser
    │                       │                       │
    │  Raw Ethernet Frame   │                       │
    │──────────────────────►│                       │
    │                       │  Parse PTP/CoAP       │
    │                       │  Decode Headers       │
    │                       │          │            │
    │                       │  WebSocket Message    │
    │                       │──────────────────────►│
    │                       │  { type: "packet",    │
    │                       │    data: { ptp: ... }}│
    │                       │                       │
    │  (Continuous)         │                       │
    │═══════════════════════│═══════════════════════│
```

---

## YANG Data Model

### IEEE 1588 PTP

```
ieee1588-ptp:ptp
├── instances
│   └── instance[]
│       ├── instance-index
│       ├── default-ds
│       │   ├── clock-identity
│       │   ├── external-port-config-enable
│       │   └── ...
│       ├── current-ds
│       │   ├── offset-from-master
│       │   └── mean-delay
│       ├── ports
│       │   └── port[]
│       │       ├── port-index
│       │       ├── port-ds
│       │       │   ├── port-state
│       │       │   └── as-capable
│       │       └── external-port-config-port-ds
│       │           └── desired-state
│       └── mchp-velocitysp-ptp:servos
│           └── servo[]
│               ├── servo-index
│               ├── state
│               └── offset
└── mchp-velocitysp-ptp:automotive
    └── profile
```

### IEEE 802.1Qbv TAS

```
ieee802-dot1q-sched:gate-parameters
├── admin-gate-states
├── admin-control-list-length
├── admin-control-list[]
│   ├── index
│   ├── gate-states-value
│   └── time-interval-value
├── admin-cycle-time
│   ├── numerator
│   └── denominator
└── admin-base-time
    ├── seconds
    └── nanoseconds
```

### IEEE 802.1Qav CBS

```
ieee802-dot1q-stream:stream-filters
└── stream-filter[]
    ├── stream-filter-instance-id
    └── max-sdu-table
        └── max-sdu[]
            ├── traffic-class
            ├── max-sdu-size
            └── transmission-overrun
```

---

## Server Architecture

### Route Structure

```
server/
├── index.js              # Express app, WebSocket setup
└── routes/
    ├── ptp.js            # PTP health, offset, config, apply
    ├── capture.js        # Packet capture (libpcap)
    ├── traffic.js        # Traffic generation
    ├── fetch.js          # Generic iFETCH
    ├── patch.js          # Generic iPATCH
    ├── get.js            # Full config fetch
    ├── config.js         # Device config management
    ├── checksum.js       # YANG catalog checksum
    ├── download.js       # YANG catalog download
    ├── list.js           # Catalog list
    ├── encode.js         # YAML→CBOR
    ├── decode.js         # CBOR→YAML
    └── rpc.js            # RPC calls (save-config, etc.)
```

### Middleware Stack

```
Request
   │
   ▼
┌──────────────┐
│    CORS      │  Cross-Origin Resource Sharing
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ JSON Parser  │  express.json()
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ URL Encoded  │  express.urlencoded()
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Routes     │  /api/*
└──────┬───────┘
       │
       ▼
┌──────────────┐
│Static Files  │  Production: client/dist
└──────────────┘
```

---

## Client Architecture

### Component Hierarchy

```
App.jsx
├── DeviceProvider (Context)
│   └── CaptureProvider (Context)
│       └── Router
│           ├── Sidebar
│           └── Routes
│               ├── Dashboard (/)
│               ├── TASDashboard (/tas-dashboard)
│               ├── CBSDashboard (/cbs-dashboard)
│               ├── PTP (/ptp)
│               ├── TAS (/tas)
│               ├── CBS (/cbs)
│               ├── Ports (/ports)
│               ├── Capture (/capture)
│               ├── Traffic (/traffic)
│               └── Settings (/settings)
```

### State Management

```
Global State (Context)
├── DeviceContext
│   └── devices: Device[]
└── CaptureContext
    ├── capturing: boolean
    └── packets: Packet[]

Local State (useState)
├── Dashboard
│   ├── boardStatus
│   ├── offsetHistory
│   ├── ptpPackets
│   └── offsetModel
├── TASDashboard
│   └── portData: { [deviceId]: TASConfig[] }
└── CBSDashboard
    └── portData: { [deviceId]: CBSConfig[] }
```

---

## Security Considerations

### Network Security

- ESP32는 격리된 네트워크에서 운용 권장
- CoAP는 암호화되지 않음 (DTLS 미사용)
- 프로덕션에서는 VPN 또는 방화벽 권장

### Input Validation

- YAML 입력 검증
- IP 주소 형식 검증
- 포트 범위 검증 (1-12)

### Error Handling

- 모든 API에서 try-catch
- Graceful degradation
- 연결 재시도 로직
