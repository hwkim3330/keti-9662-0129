/*
 * TSN Configuration Verification Tool
 * Unified CLI for verifying CBS/TAS settings by traffic analysis
 *
 * This tool:
 * 1. Sends test traffic through the TSN switch
 * 2. Captures traffic on the receive side
 * 3. Analyzes patterns to estimate actual switch configuration
 * 4. Compares with expected configuration
 *
 * Compile: gcc -O2 -o tsn-verify tsn-verify.c -lpcap -lpthread -lrt -lm
 * Run: sudo ./tsn-verify --mode cbs --tx-if enx1 --rx-if enx2 --duration 10
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
#include <getopt.h>
#include <pthread.h>
#include <errno.h>
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
#define MAX_PACKETS 100000
#define MAX_BURSTS 5000
#define MAX_GCL 64

typedef enum {
    MODE_CBS,
    MODE_TAS,
    MODE_BOTH
} test_mode_t;

// Configuration
static struct {
    test_mode_t mode;
    const char *tx_iface;
    const char *rx_iface;
    int vlan_id;
    int duration;
    int pps;
    double link_speed_mbps;
    double expected_cycle_ms;
    char tc_list[32];
    char dst_mac[32];
    char src_mac[32];
    bool json_output;
    bool verbose;
} config = {
    .mode = MODE_CBS,
    .tx_iface = NULL,
    .rx_iface = NULL,
    .vlan_id = 100,
    .duration = 10,
    .pps = 1000,
    .link_speed_mbps = 100.0,
    .expected_cycle_ms = 0,
    .tc_list = "0,1,2,3,4,5,6,7",
    .dst_mac = "",
    .src_mac = "",
    .json_output = false,
    .verbose = false
};

// Packet record
typedef struct {
    uint64_t ts_ns;
    uint16_t len;
} packet_t;

// Burst
typedef struct {
    uint64_t start_ns;
    uint64_t end_ns;
    uint32_t bytes;
    uint32_t packets;
} burst_t;

// Per-TC data
typedef struct {
    packet_t packets[MAX_PACKETS];
    int packet_count;

    burst_t bursts[MAX_BURSTS];
    int burst_count;

    uint64_t tx_count;
    uint64_t total_bytes;
    uint64_t first_ts;
    uint64_t last_ts;

    // CBS estimation
    double measured_bps;
    double estimated_idle_slope;
    double burst_ratio;
    bool is_shaped;

    // TAS estimation
    int histogram[1000];
    int histogram_size;
    double window_start_us;
    double window_duration_us;
} tc_data_t;

// Global state
static volatile int running = 1;
static tc_data_t tc_data[MAX_TC];
static pthread_mutex_t data_mutex = PTHREAD_MUTEX_INITIALIZER;
static pcap_t *rx_handle = NULL;

// TAS estimation
static uint64_t estimated_cycle_ns = 0;

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

// Parse MAC
static int parse_mac(const char *str, unsigned char *mac) {
    return sscanf(str, "%hhx:%hhx:%hhx:%hhx:%hhx:%hhx",
                  &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) == 6 ? 0 : -1;
}

// Parse TC list
static int parse_tc_list(const char *str, int *tcs) {
    int count = 0;
    char *copy = strdup(str);
    char *token = strtok(copy, ",");
    while (token && count < MAX_TC) {
        tcs[count++] = atoi(token);
        token = strtok(NULL, ",");
    }
    free(copy);
    return count;
}

// Get interface MAC
static int get_iface_mac(const char *ifname, unsigned char *mac) {
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

// Build VLAN-tagged UDP frame
static int build_frame(unsigned char *frame, unsigned char *dst, unsigned char *src,
                       int vlan_id, int pcp) {
    int offset = 0;

    memcpy(frame + offset, dst, 6); offset += 6;
    memcpy(frame + offset, src, 6); offset += 6;

    // 802.1Q VLAN
    frame[offset++] = 0x81;
    frame[offset++] = 0x00;
    uint16_t tci = ((pcp & 0x7) << 13) | (vlan_id & 0xFFF);
    frame[offset++] = (tci >> 8) & 0xFF;
    frame[offset++] = tci & 0xFF;

    // IPv4
    frame[offset++] = 0x08;
    frame[offset++] = 0x00;

    // IP header
    int ip_start = offset;
    frame[offset++] = 0x45;
    frame[offset++] = pcp << 5;

    int ip_len = 20 + 8 + 18;  // IP + UDP + payload
    frame[offset++] = (ip_len >> 8) & 0xFF;
    frame[offset++] = ip_len & 0xFF;

    frame[offset++] = 0; frame[offset++] = 0;  // ID
    frame[offset++] = 0; frame[offset++] = 0;  // Flags
    frame[offset++] = 64;  // TTL
    frame[offset++] = 17;  // UDP
    frame[offset++] = 0; frame[offset++] = 0;  // Checksum placeholder

    // IPs
    frame[offset++] = 192; frame[offset++] = 168; frame[offset++] = 100; frame[offset++] = 1;
    frame[offset++] = 192; frame[offset++] = 168; frame[offset++] = 100; frame[offset++] = 2;

    // IP checksum
    unsigned long sum = 0;
    for (int i = 0; i < 10; i++) {
        sum += ((unsigned short *)&frame[ip_start])[i];
    }
    sum = (sum >> 16) + (sum & 0xFFFF);
    sum += (sum >> 16);
    frame[ip_start + 10] = (~sum >> 8) & 0xFF;
    frame[ip_start + 11] = (~sum) & 0xFF;

    // UDP header
    int sport = 10000 + pcp;
    int dport = 20000 + pcp;
    frame[offset++] = (sport >> 8) & 0xFF;
    frame[offset++] = sport & 0xFF;
    frame[offset++] = (dport >> 8) & 0xFF;
    frame[offset++] = dport & 0xFF;

    int udp_len = 8 + 18;
    frame[offset++] = (udp_len >> 8) & 0xFF;
    frame[offset++] = udp_len & 0xFF;
    frame[offset++] = 0; frame[offset++] = 0;

    // Payload with timestamp
    uint64_t ts = get_time_ns();
    memcpy(&frame[offset], &ts, 8); offset += 8;
    frame[offset++] = pcp;  // TC identifier
    for (int i = 0; i < 9; i++) frame[offset++] = i;

    while (offset < 60) frame[offset++] = 0;

    return offset;
}

// TX thread
static void *tx_thread(void *arg) {
    (void)arg;

    int tcs[MAX_TC];
    int num_tcs = parse_tc_list(config.tc_list, tcs);

    unsigned char dst_mac[6], src_mac[6];

    // Get MACs
    if (config.dst_mac[0]) {
        parse_mac(config.dst_mac, dst_mac);
    } else {
        // Use broadcast if not specified
        memset(dst_mac, 0xFF, 6);
    }

    if (config.src_mac[0]) {
        parse_mac(config.src_mac, src_mac);
    } else {
        get_iface_mac(config.tx_iface, src_mac);
    }

    // Create raw socket
    int sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (sock < 0) {
        perror("tx socket");
        return NULL;
    }

    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, config.tx_iface, IFNAMSIZ - 1);
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
    if (bind(sock, (struct sockaddr *)&sll, sizeof(sll)) < 0) {
        perror("bind");
        close(sock);
        return NULL;
    }

    // Pre-build frames
    unsigned char frames[MAX_TC][64];
    int frame_lens[MAX_TC];
    for (int i = 0; i < num_tcs; i++) {
        frame_lens[tcs[i]] = build_frame(frames[tcs[i]], dst_mac, src_mac,
                                         config.vlan_id, tcs[i]);
    }

    // Set real-time
    struct sched_param param;
    param.sched_priority = sched_get_priority_max(SCHED_FIFO);
    sched_setscheduler(0, SCHED_FIFO, &param);
    mlockall(MCL_CURRENT | MCL_FUTURE);

    uint64_t interval_ns = 1000000000ULL / config.pps;
    uint64_t start = get_time_ns();
    uint64_t next_send = start;
    int tc_idx = 0;

    if (config.verbose) {
        fprintf(stderr, "TX: Sending %d TCs at %d pps, interval=%lu ns\n",
                num_tcs, config.pps, interval_ns);
    }

    while (running) {
        // Wait
        while (get_time_ns() < next_send && running) {}
        if (!running) break;

        int tc = tcs[tc_idx % num_tcs];
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

// RX callback
static void rx_callback(u_char *user, const struct pcap_pkthdr *hdr, const u_char *pkt) {
    (void)user;

    if (hdr->caplen < 18) return;

    uint16_t ethertype = (pkt[12] << 8) | pkt[13];
    if (ethertype != 0x8100) return;

    uint16_t tci = (pkt[14] << 8) | pkt[15];
    int pcp = (tci >> 13) & 0x07;
    int vid = tci & 0x0FFF;

    if (config.vlan_id > 0 && vid != config.vlan_id) return;

    uint64_t ts_ns = (uint64_t)hdr->ts.tv_sec * 1000000000ULL +
                     (uint64_t)hdr->ts.tv_usec * 1000ULL;

    pthread_mutex_lock(&data_mutex);

    tc_data_t *tc = &tc_data[pcp];
    if (tc->packet_count < MAX_PACKETS) {
        packet_t *p = &tc->packets[tc->packet_count];
        p->ts_ns = ts_ns;
        p->len = hdr->len;
        tc->packet_count++;
        tc->total_bytes += hdr->len;

        if (tc->first_ts == 0) tc->first_ts = ts_ns;
        tc->last_ts = ts_ns;
    }

    pthread_mutex_unlock(&data_mutex);
}

// RX thread
static void *rx_thread(void *arg) {
    (void)arg;

    char errbuf[PCAP_ERRBUF_SIZE];
    rx_handle = pcap_open_live(config.rx_iface, 128, 1, 1, errbuf);
    if (!rx_handle) {
        fprintf(stderr, "RX error: %s\n", errbuf);
        return NULL;
    }

    struct bpf_program fp;
    char filter[64];
    snprintf(filter, sizeof(filter), "vlan %d", config.vlan_id);
    if (pcap_compile(rx_handle, &fp, filter, 1, PCAP_NETMASK_UNKNOWN) == 0) {
        pcap_setfilter(rx_handle, &fp);
        pcap_freecode(&fp);
    }

    if (config.verbose) {
        fprintf(stderr, "RX: Capturing on %s (VLAN %d)\n", config.rx_iface, config.vlan_id);
    }

    while (running) {
        pcap_dispatch(rx_handle, 100, rx_callback, NULL);
    }

    pcap_close(rx_handle);
    return NULL;
}

// Detect bursts for CBS
static void detect_bursts(tc_data_t *tc) {
    if (tc->packet_count < 2) return;

    uint64_t gap_threshold = 500000;  // 500us

    burst_t *b = &tc->bursts[0];
    b->start_ns = tc->packets[0].ts_ns;
    b->bytes = tc->packets[0].len;
    b->packets = 1;
    tc->burst_count = 1;

    for (int i = 1; i < tc->packet_count && tc->burst_count < MAX_BURSTS; i++) {
        uint64_t gap = tc->packets[i].ts_ns - tc->packets[i-1].ts_ns;

        if (gap > gap_threshold) {
            b->end_ns = tc->packets[i-1].ts_ns;
            tc->burst_count++;
            b = &tc->bursts[tc->burst_count - 1];
            b->start_ns = tc->packets[i].ts_ns;
            b->bytes = tc->packets[i].len;
            b->packets = 1;
        } else {
            b->bytes += tc->packets[i].len;
            b->packets++;
        }
    }
    b->end_ns = tc->packets[tc->packet_count - 1].ts_ns;
}

// Analyze CBS
static void analyze_cbs(tc_data_t *tc) {
    if (tc->packet_count < 10) return;

    double duration_s = (tc->last_ts - tc->first_ts) / 1e9;
    if (duration_s <= 0) return;

    tc->measured_bps = (tc->total_bytes * 8.0) / duration_s;

    double total_burst = 0;
    for (int i = 0; i < tc->burst_count; i++) {
        total_burst += (tc->bursts[i].end_ns - tc->bursts[i].start_ns) / 1e3;
    }

    double total_time = duration_s * 1e6;
    tc->burst_ratio = total_burst / total_time;

    tc->is_shaped = (tc->burst_ratio < 0.85) && (tc->burst_count > 3);
    tc->estimated_idle_slope = tc->measured_bps;
}

// Detect TAS cycle
static uint64_t detect_cycle(void) {
    uint64_t candidates[] = {
        1000000, 2000000, 5000000, 10000000,
        20000000, 50000000, 100000000, 200000000
    };
    int n = sizeof(candidates) / sizeof(candidates[0]);

    if (config.expected_cycle_ms > 0) {
        return (uint64_t)(config.expected_cycle_ms * 1e6);
    }

    double best_score = 0;
    uint64_t best = 0;

    for (int c = 0; c < n; c++) {
        uint64_t cycle = candidates[c];
        double score = 0;
        int tc_count = 0;

        for (int t = 0; t < MAX_TC; t++) {
            tc_data_t *tc = &tc_data[t];
            if (tc->packet_count < 50) continue;
            tc_count++;

            int bins[50] = {0};
            uint64_t bin_size = cycle / 50;

            for (int i = 0; i < tc->packet_count; i++) {
                int bin = ((tc->packets[i].ts_ns - tc->first_ts) % cycle) / bin_size;
                if (bin < 50) bins[bin]++;
            }

            double mean = (double)tc->packet_count / 50;
            double var = 0;
            for (int b = 0; b < 50; b++) {
                double d = bins[b] - mean;
                var += d * d;
            }
            score += var / (mean * mean + 0.001);
        }

        if (tc_count > 0 && score / tc_count > best_score) {
            best_score = score / tc_count;
            best = cycle;
        }
    }

    return best;
}

// Analyze TAS
static void analyze_tas(tc_data_t *tc, uint64_t cycle_ns, int tc_idx) {
    if (tc->packet_count < 10 || cycle_ns == 0) return;

    int n_bins = 100;
    uint64_t bin_size = cycle_ns / n_bins;
    memset(tc->histogram, 0, sizeof(tc->histogram));
    tc->histogram_size = n_bins;

    for (int i = 0; i < tc->packet_count; i++) {
        int bin = ((tc->packets[i].ts_ns - tc->first_ts) % cycle_ns) / bin_size;
        if (bin < n_bins) tc->histogram[bin]++;
    }

    // Find window
    double mean = (double)tc->packet_count / n_bins;
    int threshold = (int)(mean * 0.3);
    if (threshold < 1) threshold = 1;

    int start = -1, end = -1;
    for (int i = 0; i < n_bins; i++) {
        if (tc->histogram[i] >= threshold) {
            if (start < 0) start = i;
            end = i;
        }
    }

    if (start >= 0) {
        tc->window_start_us = start * (bin_size / 1000.0);
        tc->window_duration_us = (end - start + 1) * (bin_size / 1000.0);
    }
}

// Print results
static void print_cbs_results(void) {
    double link_bps = config.link_speed_mbps * 1e6;

    if (config.json_output) {
        printf("{\"mode\":\"cbs\",\"vlan\":%d,\"link_mbps\":%.0f,\"tc\":{",
               config.vlan_id, config.link_speed_mbps);

        int first = 1;
        for (int t = 0; t < MAX_TC; t++) {
            tc_data_t *tc = &tc_data[t];
            if (tc->packet_count < 10) continue;
            if (!first) printf(",");
            first = 0;

            printf("\"%d\":{\"tx\":%lu,\"rx\":%d,\"kbps\":%.1f,\"shaped\":%s,"
                   "\"idle_slope_kbps\":%.1f,\"bw_pct\":%.2f}",
                   t, tc->tx_count, tc->packet_count, tc->measured_bps/1000,
                   tc->is_shaped ? "true" : "false",
                   tc->estimated_idle_slope/1000,
                   tc->estimated_idle_slope/link_bps*100);
        }
        printf("}}\n");
    } else {
        printf("\n");
        printf("══════════════════════════════════════════════════════════════\n");
        printf("          CBS Configuration Verification Results              \n");
        printf("══════════════════════════════════════════════════════════════\n");
        printf("Link: %.0f Mbps  VLAN: %d  Duration: %d sec\n\n", config.link_speed_mbps, config.vlan_id, config.duration);

        printf("┌────┬────────┬────────┬──────────┬─────────┬─────────────┬─────────┐\n");
        printf("│ TC │   TX   │   RX   │   Kbps   │ Shaped  │ IdleSlope   │   BW    │\n");
        printf("├────┼────────┼────────┼──────────┼─────────┼─────────────┼─────────┤\n");

        for (int t = 0; t < MAX_TC; t++) {
            tc_data_t *tc = &tc_data[t];
            if (tc->packet_count < 10 && tc->tx_count == 0) continue;

            double loss = tc->tx_count > 0 ? 100.0 * (1 - (double)tc->packet_count / tc->tx_count) : 0;

            printf("│ %2d │ %6lu │ %6d │ %8.1f │   %s   │ %9.1f K │ %5.2f%% │\n",
                   t, tc->tx_count, tc->packet_count, tc->measured_bps/1000,
                   tc->is_shaped ? "YES" : " NO",
                   tc->estimated_idle_slope/1000,
                   tc->estimated_idle_slope/link_bps*100);
        }
        printf("└────┴────────┴────────┴──────────┴─────────┴─────────────┴─────────┘\n\n");
    }
}

static void print_tas_results(void) {
    if (config.json_output) {
        printf("{\"mode\":\"tas\",\"vlan\":%d,\"cycle_ms\":%.3f,\"tc\":{",
               config.vlan_id, estimated_cycle_ns/1e6);

        int first = 1;
        for (int t = 0; t < MAX_TC; t++) {
            tc_data_t *tc = &tc_data[t];
            if (tc->packet_count < 10) continue;
            if (!first) printf(",");
            first = 0;

            printf("\"%d\":{\"tx\":%lu,\"rx\":%d,\"window_start_us\":%.1f,\"window_dur_us\":%.1f}",
                   t, tc->tx_count, tc->packet_count, tc->window_start_us, tc->window_duration_us);
        }
        printf("}}\n");
    } else {
        printf("\n");
        printf("══════════════════════════════════════════════════════════════\n");
        printf("           TAS Configuration Verification Results             \n");
        printf("══════════════════════════════════════════════════════════════\n");
        printf("VLAN: %d  Detected Cycle: %.3f ms\n\n", config.vlan_id, estimated_cycle_ns/1e6);

        printf("┌────┬────────┬────────┬─────────────┬─────────────┐\n");
        printf("│ TC │   TX   │   RX   │ Window Start│ Window Dur  │\n");
        printf("│    │        │        │     (us)    │    (us)     │\n");
        printf("├────┼────────┼────────┼─────────────┼─────────────┤\n");

        for (int t = 0; t < MAX_TC; t++) {
            tc_data_t *tc = &tc_data[t];
            if (tc->packet_count < 10 && tc->tx_count == 0) continue;

            printf("│ %2d │ %6lu │ %6d │ %11.1f │ %11.1f │\n",
                   t, tc->tx_count, tc->packet_count, tc->window_start_us, tc->window_duration_us);
        }
        printf("└────┴────────┴────────┴─────────────┴─────────────┘\n\n");
    }
}

static void usage(const char *prog) {
    fprintf(stderr, "TSN Configuration Verification Tool\n\n");
    fprintf(stderr, "Usage: %s [options]\n\n", prog);
    fprintf(stderr, "Options:\n");
    fprintf(stderr, "  --mode <cbs|tas|both>   Test mode (default: cbs)\n");
    fprintf(stderr, "  --tx-if <interface>     Transmit interface\n");
    fprintf(stderr, "  --rx-if <interface>     Receive interface\n");
    fprintf(stderr, "  --vlan <id>             VLAN ID (default: 100)\n");
    fprintf(stderr, "  --duration <sec>        Test duration (default: 10)\n");
    fprintf(stderr, "  --pps <rate>            Packets per second (default: 1000)\n");
    fprintf(stderr, "  --link-speed <mbps>     Link speed in Mbps (default: 100)\n");
    fprintf(stderr, "  --cycle <ms>            Expected TAS cycle time in ms\n");
    fprintf(stderr, "  --tc <list>             TC list (default: 0,1,2,3,4,5,6,7)\n");
    fprintf(stderr, "  --dst-mac <mac>         Destination MAC\n");
    fprintf(stderr, "  --src-mac <mac>         Source MAC (auto-detect if not set)\n");
    fprintf(stderr, "  --json                  JSON output\n");
    fprintf(stderr, "  --verbose               Verbose output\n");
    fprintf(stderr, "\nExample:\n");
    fprintf(stderr, "  %s --mode cbs --tx-if enxc84d44263ba6 --rx-if enx00e04c6812d1 --duration 10\n", prog);
}

int main(int argc, char *argv[]) {
    static struct option long_opts[] = {
        {"mode", required_argument, 0, 'm'},
        {"tx-if", required_argument, 0, 't'},
        {"rx-if", required_argument, 0, 'r'},
        {"vlan", required_argument, 0, 'v'},
        {"duration", required_argument, 0, 'd'},
        {"pps", required_argument, 0, 'p'},
        {"link-speed", required_argument, 0, 'l'},
        {"cycle", required_argument, 0, 'c'},
        {"tc", required_argument, 0, 'T'},
        {"dst-mac", required_argument, 0, 'D'},
        {"src-mac", required_argument, 0, 'S'},
        {"json", no_argument, 0, 'j'},
        {"verbose", no_argument, 0, 'V'},
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0}
    };

    int c;
    while ((c = getopt_long(argc, argv, "m:t:r:v:d:p:l:c:T:D:S:jVh", long_opts, NULL)) != -1) {
        switch (c) {
            case 'm':
                if (strcmp(optarg, "cbs") == 0) config.mode = MODE_CBS;
                else if (strcmp(optarg, "tas") == 0) config.mode = MODE_TAS;
                else if (strcmp(optarg, "both") == 0) config.mode = MODE_BOTH;
                break;
            case 't': config.tx_iface = optarg; break;
            case 'r': config.rx_iface = optarg; break;
            case 'v': config.vlan_id = atoi(optarg); break;
            case 'd': config.duration = atoi(optarg); break;
            case 'p': config.pps = atoi(optarg); break;
            case 'l': config.link_speed_mbps = atof(optarg); break;
            case 'c': config.expected_cycle_ms = atof(optarg); break;
            case 'T': strncpy(config.tc_list, optarg, sizeof(config.tc_list)-1); break;
            case 'D': strncpy(config.dst_mac, optarg, sizeof(config.dst_mac)-1); break;
            case 'S': strncpy(config.src_mac, optarg, sizeof(config.src_mac)-1); break;
            case 'j': config.json_output = true; break;
            case 'V': config.verbose = true; break;
            case 'h': usage(argv[0]); return 0;
        }
    }

    if (!config.tx_iface || !config.rx_iface) {
        fprintf(stderr, "Error: Both --tx-if and --rx-if are required\n\n");
        usage(argv[0]);
        return 1;
    }

    memset(tc_data, 0, sizeof(tc_data));
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    fprintf(stderr, "TSN Verification: mode=%s, tx=%s, rx=%s, duration=%ds\n",
            config.mode == MODE_CBS ? "CBS" : (config.mode == MODE_TAS ? "TAS" : "BOTH"),
            config.tx_iface, config.rx_iface, config.duration);

    // Start threads
    pthread_t tx_tid, rx_tid;
    pthread_create(&rx_tid, NULL, rx_thread, NULL);
    usleep(100000);  // Let RX settle
    pthread_create(&tx_tid, NULL, tx_thread, NULL);

    // Wait for duration
    uint64_t end_time = get_time_ns() + (uint64_t)config.duration * 1000000000ULL;
    while (running && get_time_ns() < end_time) {
        usleep(100000);
    }

    running = 0;
    pthread_join(tx_tid, NULL);
    pthread_join(rx_tid, NULL);

    fprintf(stderr, "Analyzing results...\n");

    // Analyze
    for (int t = 0; t < MAX_TC; t++) {
        if (tc_data[t].packet_count > 0) {
            if (config.mode == MODE_CBS || config.mode == MODE_BOTH) {
                detect_bursts(&tc_data[t]);
                analyze_cbs(&tc_data[t]);
            }
        }
    }

    if (config.mode == MODE_TAS || config.mode == MODE_BOTH) {
        estimated_cycle_ns = detect_cycle();
        for (int t = 0; t < MAX_TC; t++) {
            if (tc_data[t].packet_count > 0) {
                analyze_tas(&tc_data[t], estimated_cycle_ns, t);
            }
        }
    }

    // Output
    if (config.mode == MODE_CBS || config.mode == MODE_BOTH) {
        print_cbs_results();
    }
    if (config.mode == MODE_TAS || config.mode == MODE_BOTH) {
        print_tas_results();
    }

    return 0;
}
