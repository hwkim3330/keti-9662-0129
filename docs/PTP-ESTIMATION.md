# PTP Offset Estimation Algorithm

PTP Dashboard에서 사용하는 Offset 추정 알고리즘 문서

## Background: PTP Offset 계산의 한계

### PTP Offset 공식

```
offset = (t2 - t1) - d - C

여기서:
- t1: GM의 Sync TX 타임스탬프 (Follow_Up에서 획득)
- t2: Slave의 Sync RX 타임스탬프 (Slave 내부에서 기록)
- d:  Link Delay (Pdelay 교환으로 계산)
- C:  Correction Field (경로 지연 보정)
```

### PCAP의 한계

```
┌─────────────┐                           ┌─────────────┐
│     GM      │                           │   Slave     │
│  (Board 1)  │                           │  (Board 2)  │
└──────┬──────┘                           └──────┬──────┘
       │                                         │
       │  Sync (t1 in Follow_Up)                 │
       │────────────────────────────────────────►│ t2 (내부 기록)
       │                                         │
       │  Follow_Up (contains t1)                │
       │────────────────────────────────────────►│
       │                                         │
       │                    ▲                    │
       │                    │                    │
       │              TAP Device                 │
       │            (PCAP 캡처)                   │
       │                    │                    │
       │                    │                    │
       │    ❌ t2를 알 수 없음                    │
       │    ❌ d를 정확히 측정 불가                │
       │                                         │
```

**PCAP으로 알 수 있는 것:**
- ✅ t1 (Follow_Up 패킷의 preciseOriginTimestamp)
- ✅ C (Correction Field)
- ✅ Pdelay 교환의 타임스탬프 (t1, t2, t3, t4)
- ✅ 메시지 시퀀스, 도메인, 주기 등

**PCAP으로 알 수 없는 것:**
- ❌ t2 (Slave 내부 RX 타임스탬프)
- ❌ 정확한 Link Delay (Slave의 t4 필요)
- ❌ 따라서 **정확한 Offset 계산 불가**

---

## Baseline + Residual Model

### 핵심 아이디어

PCAP만으로는 정확한 Offset을 계산할 수 없으므로, **보드에서 보고하는 실제 Offset을 기준(Baseline)**으로 삼고, PCAP에서 추출한 특성(Feature)으로 **잔차(Residual)를 추정**하는 하이브리드 접근법 사용.

```
offset_estimated = baseline + residual

여기서:
- baseline: 보드가 보고한 최신 offset 값
- residual: PCAP 특성 기반 예측 (현재는 0으로 설정)
```

### 모델 구조

```
┌─────────────────────────────────────────────────────────────────┐
│                    PTP Offset Estimation                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐      │
│   │   Board     │     │    PCAP     │     │  Estimated  │      │
│   │   Offset    │  +  │   Features  │  =  │   Offset    │      │
│   │ (Baseline)  │     │ (Residual)  │     │  (Output)   │      │
│   └─────────────┘     └─────────────┘     └─────────────┘      │
│         │                   │                                    │
│         ▼                   ▼                                    │
│   /api/ptp/offset    WebSocket Packets                          │
│   (주기적 폴링)        (실시간 스트림)                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Feature Extraction

### PCAP에서 추출하는 특성

```javascript
ptpFeatures: {
  t1_ns_history: [],      // Follow_Up의 t1 nanoseconds 히스토리
  delta_t1_jitter: [],    // t1 간격 변동 (Jitter)
  pdelay_gap_history: [], // Pdelay 응답 간격
  d_history: [],          // 보드 보고 Link Delay 히스토리
}
```

### 1. Sync Period & Jitter 분석

```javascript
// t1 간격 계산
function normalizeDeltat1(dt) {
  const wrapped = wrapDelta(dt)      // 1초 경계 처리
  return wrapped - SYNC_PERIOD_NS    // 기대 주기(125ms) 대비 차이
}

// 통계
syncStats: {
  periodMean: 125000000,    // 평균 주기 (ns)
  periodStd: 1500,          // 주기 표준편차 (ns)
  jitterMean: 100,          // 평균 Jitter (ns)
  jitterStd: 50,            // Jitter 표준편차 (ns)
  jitterMax: 500,           // 최대 Jitter (ns)
}
```

**의미:**
- 높은 Jitter = 네트워크 불안정 = Offset 추정 신뢰도 ↓
- Jitter 패턴으로 동기화 품질 모니터링

### 2. Rate Ratio & Drift 분석

```javascript
// GM 클럭과 로컬 클럭 간 비율 계산
const rateRatio = dtPtp / dtCapture  // PTP 시간 / 캡처 시간

// PPM (Parts Per Million) 변환
const ppm = (rateRatio - 1) * 1_000_000

driftStats: {
  rateRatio: "1.000000015",   // 1 = 완벽 동기화
  ppm: "0.015",               // 양수 = GM이 빠름
  driftDirection: "fast"       // fast / slow / stable
}
```

**의미:**
- ppm > 0: GM 클럭이 더 빠름
- ppm < 0: Slave 클럭이 더 빠름
- 절대값이 클수록 클럭 품질이 나쁨

### 3. Pdelay 분석

```javascript
// PCAP에서 볼 수 있는 Pdelay 정보
// (TAP이 중간에 있으므로 일부 타임스탬프만 관측 가능)

pdelayInfo: {
  t2_ns: 123456789,        // Pdelay_Resp의 requestReceiptTimestamp
  t3_ns: 123556789,        // Pdelay_Resp_Follow_Up의 responseOriginTimestamp
  turnaround: 100000,      // t3 - t2 (Responder 처리 시간, 참고용)
  count: 45,               // 교환 횟수
}

pdelayDetails: {
  linkDelayMean: 15000,    // 평균 (참고용, 정확하지 않음)
  linkDelayStd: 500,       // 표준편차
  spikes: 2,               // 3σ 초과 이상치 수
}
```

**주의:**
- PCAP에서 계산한 turnaround은 **참고용**
- 실제 Link Delay는 보드가 보고하는 값 사용
- Spike 발생 = 네트워크 지연 불안정

### 4. Sequence Gap 분석

```javascript
ptpStructure: {
  seqGaps: [
    { type: 'Sync', expected: 100, got: 102, gap: 1, time: '10:00:01' },
    { type: 'Pdelay', expected: 50, got: 53, gap: 2, time: '10:00:05' },
  ]
}
```

**의미:**
- Sequence Gap = 패킷 손실
- 높은 손실률 = 동기화 품질 저하

---

## Offset Estimation Logic

### 현재 구현

```javascript
// Dashboard.jsx의 Offset 추정 로직

// 1. 보드에서 baseline 업데이트
useEffect(() => {
  const currentOffset = boardStatus[slaveDevice?.id]?.ptp?.offset
  if (currentOffset !== undefined && currentOffset !== null) {
    setOffsetModel(prev => ({
      baseline: currentOffset,           // 보드 보고 값을 baseline으로
      baselineTime: Date.now(),
      residualScale: 0,                  // 현재는 residual 미사용
      samples: prev.samples + 1,
      maeHistory: [...]
    }))
  }
}, [boardStatus])

// 2. Follow_Up 수신 시 추정값 계산
if (offsetModel.samples > 0) {
  const jitterArr = removeOutliers(ptpFeatures.delta_t1_jitter, 5_000_000)
  const currentJitter = jitterArr.length > 2 ? std(jitterArr) : 0

  // residual = scale * normalized_jitter
  const residual = offsetModel.residualScale * (currentJitter / 1000)

  // 추정값 = baseline + residual
  const offset_hat = Math.round(offsetModel.baseline + residual)

  setOffsetEstimates(prev => [
    ...prev,
    { time: timeStr, offset_hat, baseline: offsetModel.baseline, jitter_us: Math.round(currentJitter / 1000) }
  ].slice(-120))
}
```

### 추정 정확도 측정 (MAE)

```javascript
// Mean Absolute Error 계산
function mae(actual, predicted) {
  if (actual.length === 0 || actual.length !== predicted.length) return null
  const sum = actual.reduce((acc, a, i) => acc + Math.abs(a - predicted[i]), 0)
  return sum / actual.length
}

// MAE 히스토리 저장
offsetModel.maeHistory: [
  { time: 1706000000, mae: 15 },
  { time: 1706000005, mae: 12 },
  ...
]
```

---

## 시각화

### Offset Estimation 그래프

```
        ▲ Offset (ns)
        │
    50  │         ╭─────────╮
        │        ╱           ╲
     0  │═══════╧═════════════╧══════════ (Baseline)
        │      ╱               ╲
   -50  │─────╯                 ╰─────────
        │
        └──────────────────────────────────► Time
              │                     │
         Estimated (Accent)    Baseline (Dashed)
```

### Feature Display

```
┌─────────────────────────────────────────────────────────────┐
│ Feature Extraction                              15 updates  │
├─────────────┬─────────────┬─────────────┬─────────────────┤
│ Baseline    │ Jitter(std) │ Pdelay Gap  │ MAE             │
│ -15 ns      │ 1.2 us      │ 0.8 us      │ 12 ns           │
└─────────────┴─────────────┴─────────────┴─────────────────┘
```

---

## 향후 개선 방향

### 1. 선형 회귀 모델

```javascript
// Jitter, Drift, Pdelay 특성으로 residual 예측
residual = w1 * jitter_std + w2 * drift_ppm + w3 * pdelay_std + bias

// 학습: 보드 offset과 추정값의 차이 최소화
// Loss = (offset_actual - offset_estimated)²
```

### 2. 칼만 필터

```javascript
// State: offset
// Observation: board_reported_offset
// Process: PTP feature-based prediction

// Predict
offset_pred = offset_prev + velocity * dt

// Update
K = P / (P + R)  // Kalman Gain
offset = offset_pred + K * (board_offset - offset_pred)
```

### 3. PCAP 기반 이상 감지

```javascript
// 정상 범위 학습
const normalJitterRange = [mean - 3*std, mean + 3*std]
const normalDriftRange = [-10, 10]  // ppm

// 이상 감지
if (currentJitter > normalJitterRange[1]) {
  alert('Jitter spike detected')
}
if (Math.abs(drift_ppm) > normalDriftRange[1]) {
  alert('Clock drift anomaly')
}
```

---

## 결론

### PCAP의 역할

| 항목 | PCAP 가능 여부 | 설명 |
|------|---------------|------|
| 정확한 Offset | ❌ | t2를 알 수 없음 |
| Offset 추정 | ⚠️ | Baseline + Feature 기반 |
| 동기화 품질 | ✅ | Jitter, Drift, Loss |
| 이상 감지 | ✅ | Spike, Gap, Anomaly |
| 디버깅 | ✅ | 패킷 시퀀스, 타이밍 |

### 권장 사용법

1. **정확한 Offset이 필요하면**: 보드 API (`/api/ptp/offset`) 사용
2. **실시간 모니터링이 필요하면**: Baseline + PCAP Feature 조합
3. **동기화 품질 분석이 필요하면**: PCAP Feature (Jitter, Drift, Loss) 분석
4. **문제 디버깅이 필요하면**: PCAP 패킷 상세 분석

### 수식 요약

```
┌─────────────────────────────────────────────────────────────┐
│                                                              │
│   offset_estimated = baseline + residual                     │
│                                                              │
│   baseline = board_reported_offset (from API)                │
│                                                              │
│   residual = f(jitter, drift, pdelay_stats)                  │
│            = 0 (current implementation)                      │
│                                                              │
│   MAE = mean(|offset_actual - offset_estimated|)             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```
