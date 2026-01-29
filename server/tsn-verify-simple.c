/*
 * Simple TSN Verification - works without VLAN for initial testing
 * Sends traffic with PCP values and measures patterns
 *
 * Compile: gcc -O2 -o tsn-verify-simple tsn-verify-simple.c -lpcap -lpthread -lrt -lm
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <math.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sched.h>
#include <net/if.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <arpa/inet.h>
#include <pcap/pcap.h>

#define MAX_TC 8
#define MAX_PACKETS 50000

typedef struct {
    uint64_t ts_ns;
    uint16_t len;
} packet_t;

typedef struct {
    packet_t packets[MAX_PACKETS];
    int packet_count;
    uint64_t tx_count;
    uint64_t total_bytes;
    uint64_t first_ts;
    uint64_t last_ts;
    double measured_bps;
} tc_data_t;

static volatile int running = 1;
static tc_data_t tc_data[MAX_TC];
static pthread_mutex_t data_mutex = PTHREAD_MUTEX_INITIALIZER;
static pcap_t *rx_handle = NULL;

static const char *tx_if = NULL;
static const char *rx_if = NULL;
static int use_vlan = 0;
static int vlan_id = 100;
static int duration = 5;
static int pps = 500;

static unsigned char tx_mac[6];
static unsigned char rx_mac[6];

static uint64_t get_time_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

static void signal_handler(int sig) {
    (void)sig;
    running = 0;
    if (rx_handle) pcap_breakloop(rx_handle);
}

static int get_mac(const char *ifname, unsigned char *mac) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);
    if (ioctl(fd, SIOCGIFHWADDR, &ifr) < 0) {
        close(fd);
        return -1;
    }
    close(fd);
    memcpy(mac, ifr.ifr_hwaddr.sa_data, 6);
    return 0;
}

// Build frame with or without VLAN tag
// Uses custom EtherType 0x88B5 (local experimental) with TC in first byte of payload
static int build_frame(unsigned char *frame, int tc) {
    int offset = 0;

    memcpy(frame + offset, rx_mac, 6); offset += 6;
    memcpy(frame + offset, tx_mac, 6); offset += 6;

    if (use_vlan) {
        // 802.1Q VLAN
        frame[offset++] = 0x81;
        frame[offset++] = 0x00;
        uint16_t tci = ((tc & 0x7) << 13) | (vlan_id & 0xFFF);
        frame[offset++] = (tci >> 8) & 0xFF;
        frame[offset++] = tci & 0xFF;
    }

    // Custom EtherType for test traffic
    frame[offset++] = 0x88;
    frame[offset++] = 0xB5;

    // Payload: TC identifier + timestamp + sequence
    frame[offset++] = (uint8_t)tc;  // TC identifier in first byte

    uint64_t ts = get_time_ns();
    memcpy(&frame[offset], &ts, 8); offset += 8;

    static uint32_t seq[MAX_TC] = {0};
    uint32_t s = seq[tc]++;
    memcpy(&frame[offset], &s, 4); offset += 4;

    // Pad to 60 bytes
    while (offset < 60) frame[offset++] = 0xAA;

    return offset;
}

// Parse received frame to extract TC
static int parse_frame(const u_char *pkt, int len) {
    if (len < 20) return -1;

    // Check source MAC is our TX
    if (memcmp(pkt + 6, tx_mac, 6) != 0) return -1;

    int offset = 12;
    uint16_t ethertype = (pkt[offset] << 8) | pkt[offset + 1];
    offset += 2;

    // Skip VLAN tag if present
    if (ethertype == 0x8100) {
        // Get PCP from VLAN tag
        uint16_t tci = (pkt[offset] << 8) | pkt[offset + 1];
        int pcp = (tci >> 13) & 0x07;
        offset += 2;
        ethertype = (pkt[offset] << 8) | pkt[offset + 1];
        offset += 2;

        // Return PCP as TC
        if (ethertype == 0x88B5) {
            return pcp;
        }
    }

    // Check our test EtherType
    if (ethertype == 0x88B5) {
        // TC is in first byte of payload
        return pkt[offset] & 0x07;
    }

    return -1;
}

static void rx_callback(u_char *user, const struct pcap_pkthdr *hdr, const u_char *pkt) {
    (void)user;

    int tc = parse_frame(pkt, hdr->caplen);
    if (tc < 0) return;

    uint64_t ts_ns = (uint64_t)hdr->ts.tv_sec * 1000000000ULL +
                     (uint64_t)hdr->ts.tv_usec * 1000ULL;

    pthread_mutex_lock(&data_mutex);

    tc_data_t *td = &tc_data[tc];
    if (td->packet_count < MAX_PACKETS) {
        packet_t *p = &td->packets[td->packet_count];
        p->ts_ns = ts_ns;
        p->len = hdr->len;
        td->packet_count++;
        td->total_bytes += hdr->len;

        if (td->first_ts == 0) td->first_ts = ts_ns;
        td->last_ts = ts_ns;
    }

    pthread_mutex_unlock(&data_mutex);
}

static void *rx_thread(void *arg) {
    (void)arg;

    char errbuf[PCAP_ERRBUF_SIZE];
    rx_handle = pcap_open_live(rx_if, 128, 1, 1, errbuf);
    if (!rx_handle) {
        fprintf(stderr, "RX error: %s\n", errbuf);
        return NULL;
    }

    // Filter for packets from our TX MAC
    char filter[128];
    snprintf(filter, sizeof(filter), "ether src %02x:%02x:%02x:%02x:%02x:%02x",
             tx_mac[0], tx_mac[1], tx_mac[2], tx_mac[3], tx_mac[4], tx_mac[5]);
    struct bpf_program fp;
    if (pcap_compile(rx_handle, &fp, filter, 1, PCAP_NETMASK_UNKNOWN) == 0) {
        pcap_setfilter(rx_handle, &fp);
        pcap_freecode(&fp);
    }

    fprintf(stderr, "RX: Capturing on %s\n", rx_if);

    while (running) {
        pcap_dispatch(rx_handle, 100, rx_callback, NULL);
    }

    pcap_close(rx_handle);
    return NULL;
}

static void *tx_thread(void *arg) {
    (void)arg;

    int sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (sock < 0) {
        perror("socket");
        return NULL;
    }

    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, tx_if, IFNAMSIZ - 1);
    if (ioctl(sock, SIOCGIFINDEX, &ifr) < 0) {
        perror("ioctl");
        close(sock);
        return NULL;
    }

    struct sockaddr_ll sll;
    memset(&sll, 0, sizeof(sll));
    sll.sll_family = AF_PACKET;
    sll.sll_ifindex = ifr.ifr_ifindex;
    sll.sll_protocol = htons(ETH_P_ALL);
    bind(sock, (struct sockaddr *)&sll, sizeof(sll));

    // Pre-build frames
    unsigned char frames[MAX_TC][64];
    int frame_lens[MAX_TC];
    for (int tc = 0; tc < MAX_TC; tc++) {
        frame_lens[tc] = build_frame(frames[tc], tc);
    }

    struct sched_param param;
    param.sched_priority = sched_get_priority_max(SCHED_FIFO);
    sched_setscheduler(0, SCHED_FIFO, &param);
    mlockall(MCL_CURRENT | MCL_FUTURE);

    uint64_t interval_ns = 1000000000ULL / pps;
    uint64_t next_send = get_time_ns();
    int tc_idx = 0;

    fprintf(stderr, "TX: Sending all TCs at %d pps (interval=%lu ns)\n", pps, interval_ns);

    while (running) {
        while (get_time_ns() < next_send && running) {}
        if (!running) break;

        int tc = tc_idx % MAX_TC;

        // Update timestamp in frame
        uint64_t ts = get_time_ns();
        memcpy(&frames[tc][use_vlan ? 17 : 15], &ts, 8);

        ssize_t sent = send(sock, frames[tc], frame_lens[tc], 0);
        if (sent > 0) {
            pthread_mutex_lock(&data_mutex);
            tc_data[tc].tx_count++;
            pthread_mutex_unlock(&data_mutex);
        }

        tc_idx++;
        next_send += interval_ns;
    }

    close(sock);
    return NULL;
}

static void print_results(void) {
    printf("\n");
    printf("══════════════════════════════════════════════════════════════════\n");
    printf("              TSN Traffic Verification Results                    \n");
    printf("══════════════════════════════════════════════════════════════════\n");
    printf("TX: %s -> RX: %s  Duration: %ds  PPS: %d  VLAN: %s\n\n",
           tx_if, rx_if, duration, pps, use_vlan ? "yes" : "no");

    printf("┌────┬─────────┬─────────┬──────────┬───────────┬─────────────┐\n");
    printf("│ TC │    TX   │    RX   │  Loss %%  │  Kbps     │ Avg Int(ms) │\n");
    printf("├────┼─────────┼─────────┼──────────┼───────────┼─────────────┤\n");

    uint64_t total_tx = 0, total_rx = 0;

    for (int tc = 0; tc < MAX_TC; tc++) {
        tc_data_t *td = &tc_data[tc];

        if (td->tx_count == 0 && td->packet_count == 0) continue;

        total_tx += td->tx_count;
        total_rx += td->packet_count;

        double loss = td->tx_count > 0 ?
            100.0 * (1 - (double)td->packet_count / td->tx_count) : 0;

        double duration_s = td->packet_count > 1 ?
            (td->last_ts - td->first_ts) / 1e9 : 0;

        double kbps = duration_s > 0 ? (td->total_bytes * 8.0 / 1000.0) / duration_s : 0;

        double avg_interval_ms = td->packet_count > 1 ?
            (td->last_ts - td->first_ts) / 1e6 / (td->packet_count - 1) : 0;

        printf("│ %2d │ %7lu │ %7d │ %7.1f%% │ %9.1f │ %11.2f │\n",
               tc, td->tx_count, td->packet_count, loss, kbps, avg_interval_ms);
    }

    printf("├────┼─────────┼─────────┼──────────┼───────────┼─────────────┤\n");
    printf("│ SUM│ %7lu │ %7lu │ %7.1f%% │           │             │\n",
           total_tx, total_rx, total_tx > 0 ? 100.0 * (1 - (double)total_rx / total_tx) : 0);
    printf("└────┴─────────┴─────────┴──────────┴───────────┴─────────────┘\n\n");

    // Analysis
    if (total_rx > 0) {
        // Check for shaping
        printf("Analysis:\n");

        // Calculate interval variance per TC
        for (int tc = 0; tc < MAX_TC; tc++) {
            tc_data_t *td = &tc_data[tc];
            if (td->packet_count < 10) continue;

            // Calculate interval statistics
            double sum = 0, sum_sq = 0;
            int count = 0;
            for (int i = 1; i < td->packet_count; i++) {
                double interval = (td->packets[i].ts_ns - td->packets[i-1].ts_ns) / 1e6;
                sum += interval;
                sum_sq += interval * interval;
                count++;
            }

            if (count > 0) {
                double avg = sum / count;
                double var = (sum_sq / count) - (avg * avg);
                double stddev = var > 0 ? sqrt(var) : 0;
                double cv = avg > 0 ? stddev / avg : 0;  // Coefficient of variation

                // High CV suggests shaping/queuing
                const char *status = cv > 0.5 ? "SHAPED/QUEUED" : "REGULAR";

                printf("  TC%d: avg=%.2fms stddev=%.2fms CV=%.2f [%s]\n",
                       tc, avg, stddev, cv, status);
            }
        }
        printf("\n");
    } else {
        printf("No packets received. Check:\n");
        printf("  1. Cable connections between NICs and switch\n");
        printf("  2. Switch is powered on and configured\n");
        printf("  3. VLAN settings match switch configuration\n\n");
    }
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <tx_if> <rx_if> [duration] [pps] [--vlan <id>]\n", argv[0]);
        fprintf(stderr, "Example: %s enxc84d44263ba6 enx00e04c6812d1 5 500\n", argv[0]);
        fprintf(stderr, "         %s enxc84d44263ba6 enx00e04c6812d1 5 500 --vlan 100\n", argv[0]);
        return 1;
    }

    tx_if = argv[1];
    rx_if = argv[2];

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--vlan") == 0 && i + 1 < argc) {
            use_vlan = 1;
            vlan_id = atoi(argv[++i]);
        } else if (duration == 5 && atoi(argv[i]) > 0) {
            duration = atoi(argv[i]);
        } else if (pps == 500 && atoi(argv[i]) > 0) {
            pps = atoi(argv[i]);
        }
    }

    memset(tc_data, 0, sizeof(tc_data));
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    get_mac(tx_if, tx_mac);
    get_mac(rx_if, rx_mac);

    printf("TX MAC: %02x:%02x:%02x:%02x:%02x:%02x\n",
           tx_mac[0], tx_mac[1], tx_mac[2], tx_mac[3], tx_mac[4], tx_mac[5]);
    printf("RX MAC: %02x:%02x:%02x:%02x:%02x:%02x\n",
           rx_mac[0], rx_mac[1], rx_mac[2], rx_mac[3], rx_mac[4], rx_mac[5]);

    pthread_t rx_tid, tx_tid;
    pthread_create(&rx_tid, NULL, rx_thread, NULL);
    usleep(100000);
    pthread_create(&tx_tid, NULL, tx_thread, NULL);

    uint64_t end_time = get_time_ns() + (uint64_t)duration * 1000000000ULL;
    while (running && get_time_ns() < end_time) {
        usleep(100000);
    }

    running = 0;
    pthread_join(tx_tid, NULL);
    pthread_join(rx_tid, NULL);

    print_results();

    return 0;
}
