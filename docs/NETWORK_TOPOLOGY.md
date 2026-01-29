# Network Topology

## Hardware Setup

```
┌─────────────────────────────────────────────────────────────┐
│  PC                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ USB LAN #1   │  │ USB LAN #2   │  │   WiFi       │      │
│  │ (Monitor)    │  │ (Traffic)    │  │ (CoAP API)   │      │
│  │ TAP port 8   │  │ → port 9     │  │ 10.42.0.1    │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
└─────────┼─────────────────┼─────────────────┼───────────────┘
          │            ┌────┴────┐            │
          │            │ Board 1 │◄───────────┤
          │            │  (GM)   │            │
     ┌────┴────┐       │ Port 9  │            │
     │   TAP   │       │ Port 8 ─┼─────┐      │
     │ Mirror  │       └─────────┘     │      │
     └────┬────┘                       │ PTP  │
          │            ┌─────────┐     │      │
          └────────────┤ Board 2 │◄────┘      │
                       │ (Slave) │◄───────────┘
                       │ Port 8  │
                       └─────────┘
```

## Device Information

### Board 1 (LAN9692 TSN Switch - Grandmaster)

| Item | Value |
|------|-------|
| Controller IP (ESP32) | 10.42.0.11 |
| CoAP Port | 5683 |
| PTP Profile | gm |
| PTP Port | 8 |

**MAC Addresses:**

| Port | MAC Address | Status | Description |
|------|-------------|--------|-------------|
| 1 | E6-F4-41-C9-57-01 | down | - |
| 2 | E6-F4-41-C9-57-02 | down | - |
| 3 | E6-F4-41-C9-57-03 | down | - |
| 4 | E6-F4-41-C9-57-04 | down | - |
| 5 | E6-F4-41-C9-57-05 | down | - |
| 6 | E6-F4-41-C9-57-06 | down | - |
| 7 | E6-F4-41-C9-57-07 | down | - |
| **8** | **E6-F4-41-C9-57-08** | **up** | PTP Link to Board 2 |
| **9** | **E6-F4-41-C9-57-09** | **up** | PC Traffic Input |
| 10 | E6-F4-41-C9-57-0A | down | - |
| 11 | E6-F4-41-C9-57-0B | down | - |
| 12 | E6-F4-41-C9-57-0C | down | - |

### Board 2 (LAN9692 TSN Switch - Slave)

| Item | Value |
|------|-------|
| Controller IP (ESP32) | 10.42.0.12 |
| CoAP Port | 5683 |
| PTP Profile | bridge |
| PTP Port | 8 |

**MAC Addresses:**

| Port | MAC Address | Status | Description |
|------|-------------|--------|-------------|
| 1 | FA-AE-C9-26-A4-01 | down | - |
| 2 | FA-AE-C9-26-A4-02 | down | - |
| 3 | FA-AE-C9-26-A4-03 | down | - |
| 4 | FA-AE-C9-26-A4-04 | down | - |
| 5 | FA-AE-C9-26-A4-05 | down | - |
| 6 | FA-AE-C9-26-A4-06 | down | - |
| 7 | FA-AE-C9-26-A4-07 | down | - |
| **8** | **FA-AE-C9-26-A4-08** | **up** | PTP Link to Board 1 |
| 9 | FA-AE-C9-26-A4-09 | down | - |
| 10 | FA-AE-C9-26-A4-0A | down | - |
| 11 | FA-AE-C9-26-A4-0B | down | - |
| 12 | FA-AE-C9-26-A4-0C | down | - |

## PTP Configuration

### Board 1 (Grandmaster)
```yaml
ieee1588-ptp:ptp/instances/instance:
  instance-index: 0
  default-ds:
    external-port-config-enable: true
  mchp-velocitysp-ptp:automotive:
    profile: gm
  ports:
    port:
      - port-index: 8
        external-port-config-port-ds:
          desired-state: master
```

### Board 2 (Slave)
```yaml
ieee1588-ptp:ptp/instances/instance:
  instance-index: 0
  default-ds:
    external-port-config-enable: true
  mchp-velocitysp-ptp:automotive:
    profile: bridge
  ports:
    port:
      - port-index: 8
        external-port-config-port-ds:
          desired-state: slave
  mchp-velocitysp-ptp:servos:
    servo:
      - servo-index: 0
        servo-type: pi
        ltc-index: 0
```

## Traffic Flow

### PTP Sync Flow
```
Board 1 (GM)          Board 2 (Slave)
Port 8                Port 8
   │                     │
   │──── Sync ──────────>│
   │──── Follow_Up ─────>│
   │<─── Pdelay_Req ─────│
   │──── Pdelay_Resp ───>│
   │──── Pdelay_Resp_FU >│
```

### Test Traffic Flow
```
PC USB LAN ──> Board 1 Port 9 ──> Board 1 Port 8 ──> Board 2 Port 8
```

## Useful Commands

### Send test frame to Board 2
```bash
# ARP ping to Board 2 Port 8
sudo arping -I <usb_lan_interface> FA:AE:C9:26:A4:08

# Send raw ethernet frame
sudo python3 -c "
from scapy.all import *
sendp(Ether(dst='FA:AE:C9:26:A4:08')/IP(dst='192.168.1.1')/ICMP(),
      iface='<usb_lan_interface>')
"
```

### Monitor PTP packets
```bash
# On TAP interface
sudo tcpdump -i <tap_interface> ether proto 0x88f7 -vv
```
