#!/usr/bin/env python3
"""
Precision Traffic Sender for TSN Testing
Sends UDP packets with VLAN tags using raw sockets
"""
import sys
import time
import json
import socket
import struct

def calculate_checksum(data):
    """Calculate IP/UDP checksum"""
    if len(data) % 2:
        data += b'\x00'
    s = sum(struct.unpack('!%dH' % (len(data) // 2), data))
    s = (s >> 16) + (s & 0xffff)
    s += s >> 16
    return ~s & 0xffff

def build_udp_frame(dst_mac, src_mac, vlan_id, pcp, src_ip, dst_ip, src_port, dst_port, payload_size=10):
    """Build Ethernet frame with VLAN tag containing UDP packet"""
    # Ethernet header
    dst = bytes.fromhex(dst_mac.replace(':', '').replace('-', ''))
    src = bytes.fromhex(src_mac.replace(':', '').replace('-', ''))

    # VLAN tag (802.1Q)
    tpid = struct.pack('>H', 0x8100)
    tci = struct.pack('>H', ((pcp & 0x7) << 13) | (vlan_id & 0xFFF))

    # EtherType for IPv4
    ethertype = struct.pack('>H', 0x0800)

    # UDP payload
    payload = bytes([i % 256 for i in range(payload_size)])

    # UDP header (8 bytes)
    udp_length = 8 + len(payload)
    udp_header = struct.pack('>HHHH', src_port, dst_port, udp_length, 0)  # checksum = 0 for now

    # IP header (20 bytes, no options)
    ip_version_ihl = (4 << 4) | 5  # IPv4, IHL=5 (20 bytes)
    ip_dscp_ecn = (pcp << 5)  # Use PCP as DSCP for consistency
    ip_total_length = 20 + udp_length
    ip_id = 0
    ip_flags_frag = 0
    ip_ttl = 64
    ip_protocol = 17  # UDP
    ip_checksum = 0

    # Parse IPs
    src_ip_bytes = socket.inet_aton(src_ip)
    dst_ip_bytes = socket.inet_aton(dst_ip)

    # Build IP header without checksum
    ip_header = struct.pack('>BBHHHBBH',
        ip_version_ihl, ip_dscp_ecn, ip_total_length,
        ip_id, ip_flags_frag, ip_ttl, ip_protocol, ip_checksum
    ) + src_ip_bytes + dst_ip_bytes

    # Calculate IP checksum
    ip_checksum = calculate_checksum(ip_header)
    ip_header = struct.pack('>BBHHHBBH',
        ip_version_ihl, ip_dscp_ecn, ip_total_length,
        ip_id, ip_flags_frag, ip_ttl, ip_protocol, ip_checksum
    ) + src_ip_bytes + dst_ip_bytes

    # Build frame
    frame = dst + src + tpid + tci + ethertype + ip_header + udp_header + payload

    # Pad to minimum 60 bytes
    if len(frame) < 60:
        frame += b'\x00' * (60 - len(frame))

    return frame

def busy_wait_until(target_time):
    """Busy-wait for precise timing"""
    while time.monotonic() < target_time:
        pass

def send_traffic(interface, dst_mac, src_mac, vlan_id, tc_list, pps, duration, payload_size=10):
    """Send UDP traffic with VLAN tags"""
    try:
        sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003))
        sock.bind((interface, 0))
        sock.setblocking(False)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return

    # Pre-build frames for each TC
    frames = {}
    for tc in tc_list:
        frames[tc] = build_udp_frame(
            dst_mac, src_mac, vlan_id, tc,
            '192.168.100.1', '192.168.100.2',  # Dummy IPs
            10000 + tc, 20000 + tc,  # Ports based on TC
            payload_size
        )

    stats = {tc: 0 for tc in tc_list}
    total = 0
    num_tcs = len(tc_list)
    interval = 1.0 / pps

    start_time = time.monotonic()
    next_send_time = start_time
    tc_idx = 0

    try:
        while True:
            elapsed = time.monotonic() - start_time
            if elapsed >= duration:
                break

            if time.monotonic() < next_send_time:
                sleep_time = next_send_time - time.monotonic() - 0.0005
                if sleep_time > 0.001:
                    time.sleep(sleep_time)
                busy_wait_until(next_send_time)

            tc = tc_list[tc_idx % num_tcs]
            try:
                sock.send(frames[tc])
                stats[tc] += 1
                total += 1
            except BlockingIOError:
                pass

            tc_idx += 1
            next_send_time = start_time + (total + 1) * interval

    except KeyboardInterrupt:
        pass
    finally:
        sock.close()

    actual_duration = time.monotonic() - start_time
    actual_pps = total / actual_duration if actual_duration > 0 else 0

    print(json.dumps({
        "success": True,
        "sent": stats,
        "total": total,
        "duration": round(actual_duration, 3),
        "actual_pps": round(actual_pps, 1),
        "payload_size": payload_size
    }))

if __name__ == '__main__':
    if len(sys.argv) < 7:
        print(json.dumps({"error": "Usage: traffic-sender.py interface dst_mac src_mac vlan_id tc_list pps duration [payload_size]"}))
        sys.exit(1)

    interface = sys.argv[1]
    dst_mac = sys.argv[2]
    src_mac = sys.argv[3]
    vlan_id = int(sys.argv[4])
    tc_list = json.loads(sys.argv[5])
    pps = int(sys.argv[6])
    duration = int(sys.argv[7])
    payload_size = int(sys.argv[8]) if len(sys.argv) > 8 else 10

    send_traffic(interface, dst_mac, src_mac, vlan_id, tc_list, pps, duration, payload_size)
