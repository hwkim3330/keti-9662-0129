/*
 * Precision Traffic Sender for TSN Testing
 * Compile: gcc -O2 -o traffic-sender traffic-sender.c -lpthread -lrt
 * Run: sudo ./traffic-sender <interface> <dst_mac> <src_mac> <vlan_id> <tc_list> <pps> <duration>
 * Example: sudo ./traffic-sender enx00e04c681336 FA:AE:C9:26:A4:08 00:e0:4c:68:13:36 100 "1,2,3,4,5,6,7" 100 7
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
#define FRAME_SIZE 64
#define PAYLOAD_SIZE 10

// Frame buffer for each TC
static unsigned char frames[MAX_TCS][FRAME_SIZE];
static int frame_lens[MAX_TCS];

// Statistics
static unsigned long tx_counts[MAX_TCS];
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
                int vlan_id, int pcp) {
    int offset = 0;

    // Ethernet header
    memcpy(frame + offset, dst_mac, 6); offset += 6;
    memcpy(frame + offset, src_mac, 6); offset += 6;

    // 802.1Q VLAN tag
    frame[offset++] = 0x81;
    frame[offset++] = 0x00;
    // TCI: PCP(3) + DEI(1) + VID(12)
    unsigned short tci = ((pcp & 0x7) << 13) | (vlan_id & 0xFFF);
    frame[offset++] = (tci >> 8) & 0xFF;
    frame[offset++] = tci & 0xFF;

    // EtherType: IPv4
    frame[offset++] = 0x08;
    frame[offset++] = 0x00;

    // IP header (20 bytes)
    int ip_start = offset;
    frame[offset++] = 0x45;  // Version + IHL
    frame[offset++] = pcp << 5;  // DSCP = PCP, ECN = 0

    int ip_total_len = 20 + 8 + PAYLOAD_SIZE;  // IP + UDP + payload
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

    int udp_len = 8 + PAYLOAD_SIZE;
    frame[offset++] = (udp_len >> 8) & 0xFF;
    frame[offset++] = udp_len & 0xFF;
    frame[offset++] = 0x00; frame[offset++] = 0x00;  // Checksum (optional for IPv4)

    // Payload
    for (int i = 0; i < PAYLOAD_SIZE; i++) {
        frame[offset++] = i & 0xFF;
    }

    // Pad to minimum 60 bytes (64 with FCS, but we don't add FCS)
    while (offset < 60) {
        frame[offset++] = 0x00;
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

// Parse TC list string like "1,2,3,4,5,6,7"
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
        fprintf(stderr, "Usage: %s <interface> <dst_mac> <src_mac> <vlan_id> <tc_list> <pps> <duration>\n", argv[0]);
        fprintf(stderr, "Example: %s enx00e04c681336 FA:AE:C9:26:A4:08 00:e0:4c:68:13:36 100 \"1,2,3,4,5,6,7\" 100 7\n", argv[0]);
        return 1;
    }

    const char *ifname = argv[1];
    const char *dst_mac_str = argv[2];
    const char *src_mac_str = argv[3];
    int vlan_id = atoi(argv[4]);
    const char *tc_list_str = argv[5];
    int pps = atoi(argv[6]);
    int duration = atoi(argv[7]);

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

    // Set real-time scheduling
    struct sched_param param;
    param.sched_priority = sched_get_priority_max(SCHED_FIFO);
    if (sched_setscheduler(0, SCHED_FIFO, &param) < 0) {
        fprintf(stderr, "Warning: Failed to set SCHED_FIFO (run as root): %s\n", strerror(errno));
    }

    // Lock memory
    if (mlockall(MCL_CURRENT | MCL_FUTURE) < 0) {
        fprintf(stderr, "Warning: mlockall failed: %s\n", strerror(errno));
    }

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
        frame_lens[tcs[i]] = build_frame(frames[tcs[i]], dst_mac, src_mac, vlan_id, tcs[i]);
    }

    // Calculate interval
    unsigned long interval_ns = 1000000000UL / pps;
    unsigned long duration_ns = (unsigned long)duration * 1000000000UL;

    fprintf(stderr, "Starting traffic: %d TCs, %d PPS, %d sec, interval=%lu ns\n",
            num_tcs, pps, duration, interval_ns);

    // Initialize stats
    memset(tx_counts, 0, sizeof(tx_counts));
    total_tx = 0;

    unsigned long start_time = get_time_ns();
    unsigned long next_send = start_time;
    int tc_idx = 0;

    while (get_time_ns() - start_time < duration_ns) {
        // Wait for next send time
        wait_until(next_send);

        // Send packet
        int tc = tcs[tc_idx % num_tcs];
        ssize_t sent = send(sock, frames[tc], frame_lens[tc], 0);
        if (sent > 0) {
            tx_counts[tc]++;
            total_tx++;
        }

        tc_idx++;
        next_send += interval_ns;
    }

    unsigned long end_time = get_time_ns();
    double actual_duration = (end_time - start_time) / 1e9;
    double actual_pps = total_tx / actual_duration;

    // Print JSON result
    printf("{\"success\":true,\"sent\":{");
    int first = 1;
    for (int i = 0; i < MAX_TCS; i++) {
        if (tx_counts[i] > 0) {
            if (!first) printf(",");
            printf("\"%d\":%lu", i, tx_counts[i]);
            first = 0;
        }
    }
    printf("},\"total\":%lu,\"duration\":%.3f,\"actual_pps\":%.1f}\n",
           total_tx, actual_duration, actual_pps);

    close(sock);
    return 0;
}
