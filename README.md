# KETI TSN Switch Manager

LAN9692 TSN 스위치를 위한 웹 기반 설정 및 모니터링 UI

## Overview

LAN9692 TSN 스위치 설정을 위한 웹 기반 UI입니다. ESP32 WiFi 프록시를 통해 무선으로 스위치를 제어하며, 실시간 PTP/gPTP 모니터링, TAS/CBS 대시보드를 제공합니다.

## Quick Start

```bash
# 1. 저장소 클론
git clone https://github.com/hwkim3330/keti-tsn-cli-ui.git
cd keti-tsn-cli-ui

# 2. 의존성 설치
npm run install:all

# 3. 개발 서버 실행
npm run dev
```

브라우저에서 http://localhost:3000 접속

## Features

### Dashboards

| 대시보드 | 설명 |
|----------|------|
| **PTP Dashboard** | 실시간 PTP 동기화 상태, Offset 추이, TAP 모니터링 |
| **TAS Dashboard** | Time-Aware Shaper GCL 타임라인 시각화 |
| **CBS Dashboard** | Credit-Based Shaper 대역폭 분배 시각화 |

### TSN Configuration

| 기능 | 설명 |
|------|------|
| **gPTP (802.1AS)** | PTP 인스턴스, 포트 역할, Servo, 1PPS 설정 |
| **TAS (802.1Qbv)** | Time-Aware Shaper 게이트 스케줄 설정 |
| **CBS (802.1Qav)** | Credit-Based Shaper 대역폭 설정 |

### Tools

| 기능 | 설명 |
|------|------|
| **Port Status** | 12포트 상세 상태 및 통계 |
| **Packet Capture** | 실시간 패킷 캡처 (CoAP, PTP, TCP/UDP) |
| **Traffic Generator** | VLAN/PCP 지원 테스트 트래픽 생성 |

### System

| 기능 | 설명 |
|------|------|
| **Settings** | 장치 관리, 연결 설정 |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Web Browser                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │PTP Dashboard│  │TAS Dashboard│  │CBS Dashboard│  │Configuration│    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP/WebSocket
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Node.js Server (:3000)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  REST API    │  │  WebSocket   │  │  libpcap     │                  │
│  │  (Express)   │  │  (capture)   │  │  (pcap-cap)  │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ CoAP/UDP (port 5683)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          ESP32 WiFi Proxy                                │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  CoAP Server  ──────►  MUP1 Protocol  ──────►  Serial UART       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ Serial/UART
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        LAN9692 TSN Switch                                │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│  │ gPTP Engine│  │TAS (Qbv)   │  │CBS (Qav)   │  │ 12 Ports   │        │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘        │
└─────────────────────────────────────────────────────────────────────────┘
```

## Device Connection

### WiFi Mode (ESP32 Proxy)

```
┌────────┐   USB/TAP   ┌────────┐   WiFi    ┌────────┐   Serial   ┌─────────┐
│   PC   │◄───────────►│  TAP   │           │ ESP32  │◄──────────►│ LAN9692 │
│        │             │ Device │           │ Proxy  │            │  Switch │
└────────┘             └────────┘           └────────┘            └─────────┘
     │                                           ▲
     │              CoAP (UDP 5683)              │
     └───────────────────────────────────────────┘
```

1. ESP32가 LAN9692에 시리얼로 연결
2. PC가 ESP32에 WiFi로 연결 (핫스팟 또는 같은 네트워크)
3. Settings에서 ESP32 IP 설정

### Default Devices

| Name | IP | Port | Description |
|------|-----|------|-------------|
| ESP32 #1 | 10.42.0.11 | 5683 | Grandmaster |
| ESP32 #2 | 10.42.0.12 | 5683 | Slave/Bridge |
| ESP32 #3 | 10.42.0.13 | 5683 | Slave/Bridge |
| ESP32 #4 | 10.42.0.14 | 5683 | Slave/Bridge |

## Project Structure

```
keti-tsn-cli-ui/
├── client/                    # React Frontend (Vite)
│   ├── src/
│   │   ├── App.jsx           # 메인 앱, 라우팅, 사이드바
│   │   ├── contexts/         # React Context
│   │   │   ├── CaptureContext.jsx   # 패킷 캡처 상태
│   │   │   └── DeviceContext.jsx    # 장치 목록 관리
│   │   └── pages/            # 페이지 컴포넌트
│   │       ├── Dashboard.jsx        # PTP Dashboard
│   │       ├── TASDashboard.jsx     # TAS Dashboard
│   │       ├── CBSDashboard.jsx     # CBS Dashboard
│   │       ├── PTP.jsx              # PTP 설정
│   │       ├── TAS.jsx              # TAS 설정
│   │       ├── CBS.jsx              # CBS 설정
│   │       ├── Ports.jsx            # 포트 상태
│   │       ├── Capture.jsx          # 패킷 캡처
│   │       ├── Traffic.jsx          # 트래픽 생성기
│   │       └── Settings.jsx         # 장치 설정
│   └── vite.config.js
├── server/                    # Express Backend
│   ├── index.js              # 서버 진입점, WebSocket
│   └── routes/
│       ├── ptp.js            # PTP 상태/설정 API
│       ├── capture.js        # 패킷 캡처 API
│       ├── traffic.js        # 트래픽 생성 API
│       ├── fetch.js          # iFETCH 요청
│       ├── patch.js          # iPATCH 요청
│       ├── get.js            # GET 요청
│       ├── config.js         # 전체 설정
│       └── ...
├── tsc2cbor/                  # CBOR 변환 라이브러리
│   ├── tsc2cbor.js           # YAML → CBOR 인코더
│   ├── cbor2tsc.js           # CBOR → YAML 디코더
│   └── lib/
│       ├── transport/        # WiFi/Serial 전송
│       ├── encoder/          # 인코딩 로직
│       ├── decoder/          # 디코딩 로직
│       └── yang-catalog/     # YANG 카탈로그 관리
├── docs/                      # 문서
│   ├── API.md                # API 문서
│   ├── ARCHITECTURE.md       # 아키텍처 문서
│   ├── COMPONENTS.md         # 컴포넌트 문서
│   └── PTP-ESTIMATION.md     # PTP 추정 알고리즘
└── package.json
```

## Usage

### Development Mode

```bash
npm run dev          # 서버(3001) + 클라이언트(3000) 동시 실행
```

### Production Mode

```bash
npm run build        # 프론트엔드 빌드
npm start            # 서버 실행 (http://localhost:3000)
```

## Documentation

상세 문서는 `docs/` 폴더를 참조하세요:

- [API 문서](docs/API.md) - REST API 엔드포인트
- [아키텍처](docs/ARCHITECTURE.md) - 시스템 아키텍처
- [컴포넌트](docs/COMPONENTS.md) - UI 컴포넌트 가이드
- [PTP 추정](docs/PTP-ESTIMATION.md) - PTP Offset 추정 알고리즘

## Requirements

- Node.js 18+
- npm 9+
- libpcap (패킷 캡처용)

### Linux (Ubuntu/Debian)

```bash
sudo apt install libpcap-dev
```

### macOS

```bash
brew install libpcap
```

## License

MIT

## Author

KETI (Korea Electronics Technology Institute)
