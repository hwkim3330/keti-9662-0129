/*
 * Precision Traffic Sender for TSN/CBS Testing
 * Compile: gcc -O2 -o traffic-sender traffic-sender.c -lpthread -lrt
 * Run: ./traffic-sender <interface> <dst_mac> <src_mac> <vlan_id> <tc_list> <pps> <duration> [frame_size]
 * Example: ./traffic-sender enp11s0 FA:AE:C9:26:A4:08 00:e0:4c:68:13:36 100 "6,7" 5000 10 1000
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <sched.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <net/if.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <arpa/inet.h>

#define MAX_TCS 8
#define MAX_FRAME_SIZE 1518
#define MIN_FRAME_SIZE 64

// Frame buffer for each TC
static unsigned char frames[MAX_TCS][MAX_FRAME_SIZE];
static int frame_lens[MAX_TCS];

// Statistics
static unsigned long tx_counts[MAX_TCS];
static unsigned long tx_bytes[MAX_TCS];
static unsigned long total_tx = 0;

// Parse MAC address string to bytes
int parse_mac(const char *str, unsigned char *mac) {
    return sscanf(str, "%hhx:%hhx:%hhx:%hhx:%hhx:%hhx",
                  &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) == 6 ? 0 : -1;
}

// Calculate IP checksum
unsigned short ip_checksum(unsigned short *buf, int len) {
    unsigned long sum = 0;
    while (len > 1) {
        sum += *buf++;
        len -= 2;
    }
    if (len == 1)
        sum += *(unsigned char *)buf;
    sum = (sum >> 16) + (sum & 0xFFFF);
    sum += (sum >> 16);
    return (unsigned short)(~sum);
}

// Build Ethernet frame with VLAN tag and UDP payload
int build_frame(unsigned char *frame, unsigned char *dst_mac, unsigned char *src_mac,
                int vlan_id, int pcp, int target_frame_size) {
    int offset = 0;

    // Ethernet header (14 bytes)
    memcpy(frame + offset, dst_mac, 6); offset += 6;
    memcpy(frame + offset, src_mac, 6); offset += 6;

    // 802.1Q VLAN tag (4 bytes)
    frame[offset++] = 0x81;
    frame[offset++] = 0x00;
    unsigned short tci = ((pcp & 0x7) << 13) | (vlan_id & 0xFFF);
    frame[offset++] = (tci >> 8) & 0xFF;
    frame[offset++] = tci & 0xFF;

    // EtherType: IPv4
    frame[offset++] = 0x08;
    frame[offset++] = 0x00;

    // Calculate payload size to reach target frame size
    // Header: 6+6+4+2 = 18 bytes Ethernet+VLAN
    // IP header: 20 bytes, UDP header: 8 bytes
    int payload_size = target_frame_size - 18 - 20 - 8;
    if (payload_size < 10) payload_size = 10;
    if (payload_size > 1472) payload_size = 1472;  // MTU limit

    // IP header (20 bytes)
    int ip_start = offset;
    frame[offset++] = 0x45;  // Version + IHL
    frame[offset++] = pcp << 5;  // DSCP = PCP, ECN = 0

    int ip_total_len = 20 + 8 + payload_size;
    frame[offset++] = (ip_total_len >> 8) & 0xFF;
    frame[offset++] = ip_total_len & 0xFF;

    frame[offset++] = 0x00; frame[offset++] = 0x00;  // ID
    frame[offset++] = 0x00; frame[offset++] = 0x00;  // Flags + Fragment
    frame[offset++] = 64;   // TTL
    frame[offset++] = 17;   // Protocol: UDP
    frame[offset++] = 0x00; frame[offset++] = 0x00;  // Checksum (placeholder)

    // Source IP: 192.168.100.1
    frame[offset++] = 192; frame[offset++] = 168; frame[offset++] = 100; frame[offset++] = 1;
    // Dest IP: 192.168.100.2
    frame[offset++] = 192; frame[offset++] = 168; frame[offset++] = 100; frame[offset++] = 2;

    // Calculate IP checksum
    unsigned short ip_cksum = ip_checksum((unsigned short *)(frame + ip_start), 20);
    frame[ip_start + 10] = (ip_cksum >> 8) & 0xFF;
    frame[ip_start + 11] = ip_cksum & 0xFF;

    // UDP header (8 bytes)
    int src_port = 10000 + pcp;
    int dst_port = 20000 + pcp;
    frame[offset++] = (src_port >> 8) & 0xFF;
    frame[offset++] = src_port & 0xFF;
    frame[offset++] = (dst_port >> 8) & 0xFF;
    frame[offset++] = dst_port & 0xFF;

    int udp_len = 8 + payload_size;
    frame[offset++] = (udp_len >> 8) & 0xFF;
    frame[offset++] = udp_len & 0xFF;
    frame[offset++] = 0x00; frame[offset++] = 0x00;  // Checksum (optional)

    // Payload with TC marker
    frame[offset++] = 'T';
    frame[offset++] = 'C';
    frame[offset++] = '0' + pcp;
    for (int i = 3; i < payload_size; i++) {
        frame[offset++] = (i + pcp) & 0xFF;
    }

    return offset;
}

// Get current time in nanoseconds
static inline unsigned long get_time_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000000000UL + ts.tv_nsec;
}

// Busy wait until target time
static inline void wait_until(unsigned long target_ns) {
    while (get_time_ns() < target_ns) {
        // Spin
    }
}

// Parse TC list string like "6,7"
int parse_tc_list(const char *str, int *tcs) {
    int count = 0;
    char *copy = strdup(str);
    char *token = strtok(copy, ",");
    while (token && count < MAX_TCS) {
        tcs[count++] = atoi(token);
        token = strtok(NULL, ",");
    }
    free(copy);
    return count;
}

int main(int argc, char *argv[]) {
    if (argc < 8) {
        fprintf(stderr, "Usage: %s <iface> <dst_mac> <src_mac> <vlan> <tc_list> <pps> <duration> [frame_size]\n", argv[0]);
        fprintf(stderr, "Example: %s enp11s0 FA:AE:C9:26:A4:08 00:e0:4c:68:13:36 100 \"6,7\" 5000 10 1000\n", argv[0]);
        fprintf(stderr, "\nFrame size default: 1000 bytes (gives ~8Mbps at 1000 pps per TC)\n");
        return 1;
    }

    const char *ifname = argv[1];
    const char *dst_mac_str = argv[2];
    const char *src_mac_str = argv[3];
    int vlan_id = atoi(argv[4]);
    const char *tc_list_str = argv[5];
    int pps = atoi(argv[6]);
    int duration = atoi(argv[7]);
    int frame_size = argc > 8 ? atoi(argv[8]) : 1000;  // Default 1000 bytes

    if (frame_size < MIN_FRAME_SIZE) frame_size = MIN_FRAME_SIZE;
    if (frame_size > MAX_FRAME_SIZE) frame_size = MAX_FRAME_SIZE;

    unsigned char dst_mac[6], src_mac[6];
    if (parse_mac(dst_mac_str, dst_mac) < 0 || parse_mac(src_mac_str, src_mac) < 0) {
        fprintf(stderr, "Invalid MAC address format\n");
        return 1;
    }

    int tcs[MAX_TCS];
    int num_tcs = parse_tc_list(tc_list_str, tcs);
    if (num_tcs == 0) {
        fprintf(stderr, "No TCs specified\n");
        return 1;
    }

    // Set real-time scheduling (may fail without root)
    struct sched_param param;
    param.sched_priority = sched_get_priority_max(SCHED_FIFO);
    if (sched_setscheduler(0, SCHED_FIFO, &param) < 0) {
        // Not critical, continue anyway
    }

    // Lock memory
    mlockall(MCL_CURRENT | MCL_FUTURE);

    // Create raw socket
    int sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (sock < 0) {
        perror("socket");
        return 1;
    }

    // Get interface index
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);
    if (ioctl(sock, SIOCGIFINDEX, &ifr) < 0) {
        perror("ioctl SIOCGIFINDEX");
        close(sock);
        return 1;
    }

    // Bind to interface
    struct sockaddr_ll sll;
    memset(&sll, 0, sizeof(sll));
    sll.sll_family = AF_PACKET;
    sll.sll_ifindex = ifr.ifr_ifindex;
    sll.sll_protocol = htons(ETH_P_ALL);
    if (bind(sock, (struct sockaddr *)&sll, sizeof(sll)) < 0) {
        perror("bind");
        close(sock);
        return 1;
    }

    // Pre-build frames for each TC
    for (int i = 0; i < num_tcs; i++) {
        frame_lens[tcs[i]] = build_frame(frames[tcs[i]], dst_mac, src_mac, vlan_id, tcs[i], frame_size);
    }

    // Calculate interval (PPS is total, divided among TCs)
    // For CBS testing, we want high rate PER TC
    unsigned long interval_ns = 1000000000UL / pps;
    unsigned long duration_ns = (unsigned long)duration * 1000000000UL;

    // Calculate expected bandwidth per TC
    double bits_per_frame = frame_size * 8.0;
    double pps_per_tc = (double)pps / num_tcs;
    double mbps_per_tc = (pps_per_tc * bits_per_frame) / 1000000.0;

    fprintf(stderr, "=== CBS Traffic Test ===\n");
    fprintf(stderr, "Interface: %s\n", ifname);
    fprintf(stderr, "TCs: ");
    for (int i = 0; i < num_tcs; i++) fprintf(stderr, "%d ", tcs[i]);
    fprintf(stderr, "\n");
    fprintf(stderr, "Frame size: %d bytes\n", frame_size);
    fprintf(stderr, "Total PPS: %d (%.1f pps/TC)\n", pps, pps_per_tc);
    fprintf(stderr, "Expected BW/TC: %.2f Mbps\n", mbps_per_tc);
    fprintf(stderr, "Duration: %d sec\n", duration);
    fprintf(stderr, "========================\n");

    // Initialize stats
    memset(tx_counts, 0, sizeof(tx_counts));
    memset(tx_bytes, 0, sizeof(tx_bytes));
    total_tx = 0;

    unsigned long start_time = get_time_ns();
    unsigned long next_send = start_time;
    int tc_idx = 0;

    while (get_time_ns() - start_time < duration_ns) {
        wait_until(next_send);

        int tc = tcs[tc_idx % num_tcs];
        ssize_t sent = send(sock, frames[tc], frame_lens[tc], 0);
        if (sent > 0) {
            tx_counts[tc]++;
            tx_bytes[tc] += sent;
            total_tx++;
        }

        tc_idx++;
        next_send += interval_ns;
    }

    close(sock);

    unsigned long end_time = get_time_ns();
    double actual_duration = (end_time - start_time) / 1e9;
    double actual_pps = total_tx / actual_duration;

    // Print results to stderr
    fprintf(stderr, "\n=== Results ===\n");
    fprintf(stderr, "Duration: %.2f sec\n", actual_duration);
    fprintf(stderr, "Total packets: %lu (%.1f pps)\n", total_tx, actual_pps);
    for (int i = 0; i < MAX_TCS; i++) {
        if (tx_counts[i] > 0) {
            double tc_pps = tx_counts[i] / actual_duration;
            double tc_mbps = (tx_bytes[i] * 8.0) / (actual_duration * 1000000.0);
            fprintf(stderr, "TC%d: %lu pkts (%.1f pps, %.2f Mbps)\n", i, tx_counts[i], tc_pps, tc_mbps);
        }
    }

    // Print JSON result to stdout
    printf("{\"success\":true,\"duration\":%.2f,\"total\":%lu,\"pps\":%.1f,\"sent\":{",
           actual_duration, total_tx, actual_pps);
    int first = 1;
    for (int i = 0; i < MAX_TCS; i++) {
        if (tx_counts[i] > 0) {
            double tc_mbps = (tx_bytes[i] * 8.0) / (actual_duration * 1000000.0);
            if (!first) printf(",");
            printf("\"%d\":{\"packets\":%lu,\"bytes\":%lu,\"mbps\":%.2f}", i, tx_counts[i], tx_bytes[i], tc_mbps);
            first = 0;
        }
    }
    printf("}}\n");

    return 0;
}
