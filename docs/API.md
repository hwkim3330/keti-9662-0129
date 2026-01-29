# API Documentation

KETI TSN Switch Manager REST API 문서

## Base URL

```
http://localhost:3000/api
```

## Health Check

### GET /api/health

서버 상태 확인

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-27T10:00:00.000Z"
}
```

---

## PTP API

### GET /api/ptp/health/:ip

보드 PTP 상태 확인 (Grandmaster용)

**Parameters:**
- `ip` - ESP32 프록시 IP 주소

**Response:**
```json
{
  "online": true,
  "latency": 150,
  "ptp": {
    "profile": "gm",
    "clockId": "00:04:a3:ff:fe:12:34:56",
    "gmId": "00:04:a3:ff:fe:12:34:56",
    "isGM": true,
    "portState": "master",
    "asCapable": true,
    "servoState": null,
    "offset": null,
    "meanLinkDelay": null
  },
  "cached": false
}
```

### GET /api/ptp/offset/:ip

Slave 보드 Offset 조회

**Parameters:**
- `ip` - ESP32 프록시 IP 주소

**Response:**
```json
{
  "online": true,
  "latency": 120,
  "offset": -15,
  "servoState": 2,
  "portState": "slave",
  "profile": "bridge",
  "asCapable": true,
  "meanLinkDelay": 13107200
}
```

**Notes:**
- `offset`: 나노초 단위 시간 오프셋
- `servoState`: 0=Init, 1=Tracking, 2=Locked, 3=Holdover
- `meanLinkDelay`: Fixed-point (÷65536 = ns)

### GET /api/ptp/status

캐시된 모든 보드 상태

**Response:**
```json
{
  "10.42.0.11": {
    "online": true,
    "lastCheck": 1706000000000,
    "latency": 150,
    "ptp": { ... }
  },
  "10.42.0.12": { ... }
}
```

### GET /api/ptp/config/:ip

전체 PTP 설정 조회

**Response:**
```json
{
  "raw": "ieee1588-ptp:ptp:\n  instances:\n    ...",
  "parsed": {
    "profile": "bridge",
    "portState": "slave",
    ...
  }
}
```

### POST /api/ptp/apply/:ip

PTP 프로파일 적용

**Request Body:**
```json
{
  "profile": "gm",
  "portIndex": 8
}
```

**Profiles:**
- `gm` - Grandmaster 설정
- `bridge` - Slave/Bridge 설정

**Response:**
```json
{
  "success": true,
  "profile": "gm",
  "message": "Applied Grandmaster profile to 10.42.0.11"
}
```

### POST /api/ptp/save/:ip

현재 설정을 startup-config에 저장

**Response:**
```json
{
  "success": true,
  "message": "Configuration saved"
}
```

---

## Capture API

### GET /api/capture/interfaces

사용 가능한 네트워크 인터페이스 목록

**Response:**
```json
[
  {
    "name": "eth0",
    "description": "Ethernet",
    "addresses": ["192.168.1.100"]
  },
  {
    "name": "enxc84d44231cc2",
    "description": "USB TAP Device",
    "addresses": ["10.42.0.1"]
  }
]
```

### POST /api/capture/start

패킷 캡처 시작

**Request Body:**
```json
{
  "interfaces": ["eth0", "enxc84d44231cc2"],
  "port": 5683,
  "host": "",
  "captureMode": "coap"
}
```

**Capture Modes:**
- `coap` - CoAP 패킷만 (기본값, UDP port 5683)
- `ptp` - PTP/gPTP 패킷만 (EtherType 0x88F7, UDP 319/320)
- `all` - 모든 IP 패킷

**Response:**
```json
{
  "success": true,
  "message": "Capture started on 2 interface(s)",
  "started": [
    { "interface": "eth0", "filter": "udp port 5683" },
    { "interface": "enxc84d44231cc2", "filter": "ether proto 0x88f7 or udp port 319 or udp port 320" }
  ]
}
```

### POST /api/capture/stop

패킷 캡처 중지

**Request Body:**
```json
{
  "interfaces": ["eth0"]
}
```

인터페이스 미지정시 모든 캡처 중지

**Response:**
```json
{
  "success": true,
  "stopped": ["eth0", "enxc84d44231cc2"]
}
```

### GET /api/capture/status

캡처 상태 조회

**Response:**
```json
{
  "running": true,
  "activeCaptures": [
    { "interface": "eth0", "packetCount": 150, "errorCount": 0 }
  ],
  "totalInterfaces": 1,
  "clients": 2,
  "globalPacketCount": 150
}
```

### WebSocket /ws/capture

실시간 패킷 스트림

**Messages:**

Sync (연결 시):
```json
{
  "type": "sync",
  "data": {
    "running": true,
    "activeCaptures": [...],
    "totalInterfaces": 1,
    "globalPacketCount": 50
  }
}
```

Packet:
```json
{
  "type": "packet",
  "data": {
    "id": 123,
    "time": "2024-01-27T10:00:00.000Z",
    "interface": "enxc84d44231cc2",
    "source": "00:04:a3:12:34:56",
    "destination": "01:80:c2:00:00:0e",
    "protocol": "PTP",
    "info": "Sync Seq=1234 Domain=0",
    "length": 86,
    "ptp": {
      "msgType": "Sync",
      "sequenceId": 1234,
      "domainNumber": 0,
      "clockId": "00:04:a3:ff:fe:12:34:56",
      "sourcePortId": "00:04:a3:ff:fe:12:34:56:1",
      "timestamp": { "seconds": 1706000000, "nanoseconds": 123456789 },
      "correction": 0,
      "twoStepFlag": true,
      "logMessagePeriod": -3
    }
  }
}
```

Stopped:
```json
{
  "type": "stopped",
  "interfaces": ["eth0"]
}
```

---

## Traffic Generator API

### GET /api/traffic/interfaces

사용 가능한 인터페이스 목록 (캡처 API와 동일)

### POST /api/traffic/start

트래픽 생성 시작

**Request Body:**
```json
{
  "interface": "eth0",
  "dstMac": "00:11:22:33:44:55",
  "srcMac": "00:aa:bb:cc:dd:ee",
  "vlanId": 100,
  "pcp": 5,
  "packetSize": 100,
  "packetsPerSecond": 1000,
  "duration": 60,
  "count": 0
}
```

**Parameters:**
- `vlanId`: 0=untagged, 1-4094=VLAN ID
- `pcp`: Priority Code Point (0-7)
- `duration`: 초 단위 (0=무제한)
- `count`: 패킷 수 (0=무제한)

**Response:**
```json
{
  "success": true,
  "message": "Traffic generator started on eth0",
  "config": {
    "interface": "eth0",
    "dstMac": "00:11:22:33:44:55",
    "srcMac": "00:aa:bb:cc:dd:ee",
    "vlanId": 100,
    "pcp": 5,
    "packetSize": 100,
    "packetsPerSecond": 1000,
    "duration": 60,
    "count": "unlimited"
  }
}
```

### POST /api/traffic/stop

트래픽 생성 중지

**Request Body:**
```json
{
  "interface": "eth0"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Traffic generator stopped on eth0",
  "stats": {
    "sent": 60000,
    "errors": 0,
    "duration": 60123
  }
}
```

### GET /api/traffic/status

트래픽 생성기 상태

**Response:**
```json
{
  "active": 1,
  "generators": [
    {
      "interface": "eth0",
      "running": true,
      "sent": 30000,
      "errors": 0,
      "duration": 30000,
      "config": { ... }
    }
  ]
}
```

### POST /api/traffic/send

단일 패킷 전송 (테스트용)

**Request Body:**
```json
{
  "interface": "eth0",
  "dstMac": "00:11:22:33:44:55",
  "vlanId": 100,
  "pcp": 5,
  "packetSize": 100
}
```

---

## Device API

### POST /api/fetch

iFETCH 요청 (특정 설정값 조회)

**Request Body:**
```json
{
  "host": "10.42.0.11",
  "port": 5683,
  "query": "/ieee1588-ptp:ptp"
}
```

**Response:**
```json
{
  "success": true,
  "yaml": "ieee1588-ptp:ptp:\n  instances:\n    ...",
  "latency": 150
}
```

### POST /api/patch

iPATCH 요청 (설정값 변경)

**Request Body:**
```json
{
  "host": "10.42.0.11",
  "port": 5683,
  "yaml": "- /ieee1588-ptp:ptp/instances/instance[instance-index='0']:\n    default-ds:\n      external-port-config-enable: true"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Patch applied",
  "latency": 200
}
```

### POST /api/get

전체 설정 조회 (YANG tree)

**Request Body:**
```json
{
  "host": "10.42.0.11",
  "port": 5683
}
```

---

## Config API

### GET /api/config/devices

저장된 장치 목록 조회

### POST /api/config/devices

장치 추가/수정

**Request Body:**
```json
{
  "id": "device-1",
  "name": "ESP32 #1",
  "host": "10.42.0.11",
  "port": 5683
}
```

### DELETE /api/config/devices/:id

장치 삭제

---

## YANG Catalog API

### GET /api/checksum/:ip

장비 YANG 카탈로그 체크섬 조회

### POST /api/download

YANG 카탈로그 다운로드

### GET /api/list

캐시된 카탈로그 목록

---

## Encode/Decode API

### POST /api/encode

YAML → CBOR 변환

**Request Body:**
```json
{
  "yaml": "- /ieee1588-ptp:ptp:\n    ...",
  "catalog": "auto"
}
```

### POST /api/decode

CBOR → YAML 변환

**Request Body:**
```json
{
  "cbor": "a119520ba1...",
  "catalog": "auto"
}
```

---

## Error Responses

모든 API는 에러 시 다음 형식으로 응답:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

HTTP Status Codes:
- `200` - 성공
- `400` - 잘못된 요청
- `404` - 리소스 없음
- `500` - 서버 에러
