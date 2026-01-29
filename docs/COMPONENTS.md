# Components Documentation

KETI TSN Switch Manager UI 컴포넌트 가이드

## Page Components

### Dashboard.jsx (PTP Dashboard)

PTP 동기화 상태를 실시간으로 모니터링하는 대시보드

**주요 기능:**
- 보드 간 동기화 상태 토폴로지 뷰
- 실시간 Offset 히스토리 그래프
- TAP 장치를 통한 PTP 패킷 모니터링
- Offset 추정 알고리즘 (Baseline + Residual 모델)

**State 구조:**
```javascript
// 보드 상태
boardStatus: { [deviceId]: { online, ptp: { offset, servoState, ... } } }

// Offset 히스토리 (그래프용)
offsetHistory: [{ time, [deviceName]: offsetValue }]

// PTP 패킷 분석
ptpPackets: []          // 원시 패킷 목록
syncPairs: []           // Sync + Follow_Up 쌍
pdelayInfo: {}          // Pdelay 교환 정보

// 통계
syncStats: { periodMean, periodStd, jitterMean, ... }
driftStats: { rateRatio, ppm, driftDirection }
pdelayDetails: { exchanges, linkDelayHistory, spikes }

// Offset 추정 모델
offsetModel: { baseline, residualScale, samples, maeHistory }
offsetEstimates: []     // 추정값 히스토리
```

**데이터 흐름:**
```
ESP32 → CoAP → Server → REST API → Dashboard (보드 상태)
TAP Device → libpcap → WebSocket → Dashboard (PTP 패킷)
```

---

### TASDashboard.jsx (TAS Dashboard)

Time-Aware Shaper Gate Control List 시각화

**주요 기능:**
- 멀티 디바이스 TAS 상태 개요
- GCL 타임라인 시각화 (Traffic Class별 열림/닫힘)
- Gate State 비트마스크 → TC 상태 변환
- 포트별 GCL 상세 테이블

**Gate State 비트마스크:**
```javascript
// Gate State 값 해석 (8비트)
// Bit 0 = TC0, Bit 1 = TC1, ..., Bit 7 = TC7
// 1 = Open, 0 = Closed

// 예: gate-states-value = 0x83 = 10000011
// TC0: Open, TC1: Open, TC7: Open
// TC2-TC6: Closed
```

**TC 색상 스키마:**
```javascript
const TC_COLORS = {
  0: '#64748b',  // slate (Best Effort)
  1: '#f97316',  // orange
  2: '#eab308',  // yellow
  3: '#22c55e',  // green
  4: '#06b6d4',  // cyan
  5: '#3b82f6',  // blue
  6: '#8b5cf6',  // purple
  7: '#ec4899',  // pink (Highest Priority)
}
```

---

### CBSDashboard.jsx (CBS Dashboard)

Credit-Based Shaper 대역폭 분배 시각화

**주요 기능:**
- 멀티 디바이스 CBS 개요
- TC별 idleSlope/sendSlope 시각화
- 포트 그리드 (12포트) 대역폭 바
- 디바이스 비교 테이블

**CBS 계산:**
```javascript
// idleSlope: 크레딧 증가율 (Mbps)
// sendSlope: 크레딧 감소율 (Mbps, 음수)
// 대역폭 비율 = idleSlope / portSpeed * 100
```

---

### PTP.jsx (PTP Configuration)

PTP/gPTP 설정 페이지

**주요 기능:**
- 프로파일 선택 (GM / Bridge)
- 포트별 역할 설정 (Master / Slave)
- Servo 설정
- 1PPS 출력 설정
- 설정 저장 (startup-config)

**PTP 프로파일:**
```javascript
// Grandmaster
{
  'mchp-velocitysp-ptp:automotive': { profile: 'gm' },
  'default-ds': { 'external-port-config-enable': true },
  'ports': { port: [{ 'port-index': 8, 'desired-state': 'master' }] }
}

// Bridge/Slave
{
  'mchp-velocitysp-ptp:automotive': { profile: 'bridge' },
  'default-ds': { 'external-port-config-enable': true },
  'ports': { port: [{ 'port-index': 8, 'desired-state': 'slave' }] },
  'servos': { servo: [{ 'servo-index': 0, 'servo-type': 'pi', 'ltc-index': 0 }] }
}
```

---

### TAS.jsx (TAS Configuration)

Time-Aware Shaper 설정 페이지

**주요 기능:**
- GCL (Gate Control List) 편집
- Cycle Time 설정
- Base Time 설정
- Gate State 비트마스크 편집
- Config Change 적용

**GCL 데이터 구조:**
```javascript
{
  "admin-gate-states": 255,           // 초기 상태
  "admin-control-list-length": 2,
  "admin-control-list": [
    {
      "index": 0,
      "gate-states-value": 129,       // 0x81: TC0, TC7 Open
      "time-interval-value": 500000   // 500us
    },
    {
      "index": 1,
      "gate-states-value": 126,       // 0x7E: TC1-TC6 Open
      "time-interval-value": 500000
    }
  ],
  "admin-cycle-time": {
    "numerator": 1000000,             // 1ms
    "denominator": 1000000000
  }
}
```

---

### CBS.jsx (CBS Configuration)

Credit-Based Shaper 설정 페이지

**주요 기능:**
- TC별 idleSlope/sendSlope 설정
- 대역폭 비율 계산
- 포트별 개별 설정

---

### Ports.jsx (Port Status)

12포트 상태 모니터링

**주요 기능:**
- 포트별 링크 상태 (Up/Down)
- 속도/듀플렉스
- 통계 (TX/RX packets, errors)
- MIB 카운터

---

### Capture.jsx (Packet Capture)

실시간 패킷 캡처

**주요 기능:**
- 인터페이스 선택 (멀티 선택)
- 캡처 모드 (CoAP/PTP/All)
- 실시간 패킷 테이블
- 패킷 상세 보기 (Hex/ASCII)
- 필터링

**캡처 모드:**
```javascript
'coap' → 'udp port 5683'
'ptp'  → 'ether proto 0x88f7 or udp port 319 or udp port 320'
'all'  → 'ip'
```

---

### Traffic.jsx (Traffic Generator)

테스트 트래픽 생성

**주요 기능:**
- 목적지 MAC 설정
- VLAN ID / PCP 설정
- 패킷 크기 / 전송률 설정
- 지속 시간 / 패킷 수 제한

**프레임 구조:**
```
Untagged (14 bytes header):
┌──────────┬──────────┬───────────┬─────────┐
│ Dst MAC  │ Src MAC  │ EtherType │ Payload │
│  6 bytes │  6 bytes │  2 bytes  │  N bytes│
└──────────┴──────────┴───────────┴─────────┘

Tagged (18 bytes header):
┌──────────┬──────────┬──────┬─────┬───────────┬─────────┐
│ Dst MAC  │ Src MAC  │ TPID │ TCI │ EtherType │ Payload │
│  6 bytes │  6 bytes │0x8100│PCP+VID│  2 bytes │  N bytes│
└──────────┴──────────┴──────┴─────┴───────────┴─────────┘
```

---

### Settings.jsx (Device Settings)

장치 관리

**주요 기능:**
- 장치 추가/수정/삭제
- 연결 테스트
- YANG 카탈로그 동기화

---

## Context Providers

### DeviceContext.jsx

장치 목록 전역 상태 관리

```javascript
const DeviceContext = createContext()

// 제공 값
{
  devices: [{ id, name, host, port }],
  addDevice: (device) => void,
  updateDevice: (id, updates) => void,
  removeDevice: (id) => void,
  refreshDevices: () => void
}
```

### CaptureContext.jsx

패킷 캡처 전역 상태 관리

```javascript
const CaptureContext = createContext()

// 제공 값
{
  capturing: boolean,
  packets: [],
  interfaces: [],
  activeInterfaces: [],
  startCapture: (interfaces, mode) => void,
  stopCapture: () => void,
  clearPackets: () => void
}
```

---

## Common Styles

### 색상 팔레트 (Muted)

```javascript
const colors = {
  text: '#334155',        // 기본 텍스트
  textMuted: '#64748b',   // 보조 텍스트
  textLight: '#94a3b8',   // 비활성 텍스트
  bg: '#f8fafc',          // 배경
  bgAlt: '#f1f5f9',       // 대체 배경
  border: '#e2e8f0',      // 테두리
  accent: '#475569',      // 강조색
  success: '#059669',     // 성공
  warning: '#d97706',     // 경고
  error: '#dc2626',       // 에러
}
```

### 공통 스타일

```javascript
// 통계 박스
const statBox = {
  padding: '12px',
  background: colors.bg,
  borderRadius: '6px',
  border: `1px solid ${colors.border}`
}

// 라벨
const statLabel = {
  fontSize: '0.65rem',
  color: colors.textMuted,
  marginBottom: '4px'
}

// 값
const statValue = {
  fontWeight: '600',
  fontSize: '0.9rem',
  fontFamily: 'monospace',
  color: colors.text
}

// 섹션 제목
const sectionTitle = {
  fontSize: '0.8rem',
  fontWeight: '600',
  color: colors.text,
  marginBottom: '12px',
  paddingBottom: '8px',
  borderBottom: `1px solid ${colors.border}`
}
```

---

## Data Visualization

### Recharts 사용

```javascript
import {
  LineChart, Line,
  XAxis, YAxis,
  CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from 'recharts'

// 기본 설정
<ResponsiveContainer width="100%" height={200}>
  <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
    <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
    <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke={colors.textLight} />
    <YAxis tick={{ fontSize: 10 }} stroke={colors.textLight} />
    <Tooltip contentStyle={{ fontSize: '0.75rem' }} />
    <ReferenceLine y={0} stroke={colors.textLight} strokeDasharray="3 3" />
    <Line type="monotone" dataKey="value" stroke={colors.accent} strokeWidth={1.5} dot={false} />
  </LineChart>
</ResponsiveContainer>
```
