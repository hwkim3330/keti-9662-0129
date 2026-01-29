/*
 * CBS Idle Slope Estimator
 * Estimates CBS (Credit-Based Shaper) idle slope from captured traffic
 *
 * IEEE 802.1Qav CBS Parameters:
 *   - idleSlope: Credit accumulation rate when idle (bits/sec)
 *   - sendSlope: Credit consumption rate when sending (bits/sec, negative)
 *   - hiCredit: Maximum credit (bytes)
 *   - loCredit: Minimum credit (bytes, negative)
 *
 * Estimation Method:
 *   1. Capture traffic and measure actual throughput per TC
 *   2. Detect burst patterns and inter-burst gaps
 *   3. Estimate idleSlope = measured_bandwidth when saturated
 *   4. Detect shaped vs unshaped traffic via burst analysis
 *
 * Compile: gcc -O2 -o cbs-estimator cbs-estimator.c -lpcap -lpthread -lm
 * Run: sudo ./cbs-estimator <interface> <duration> <vlan_id> [link_speed_mbps]
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
#include <sys/mman.h>
#include <sched.h>
#include <pthread.h>
#include <pcap/pcap.h>

#define MAX_TC 8
#define MAX_PACKETS 100000
#define MAX_BURSTS 10000

// Packet record
typedef struct {
    uint64_t ts_ns;
    uint16_t len;
    uint8_t tc;
} packet_t;

// Burst detection
typedef struct {
    uint64_t start_ns;
    uint64_t end_ns;
    uint32_t bytes;
    uint32_t packets;
} burst_t;

// Per-TC analysis
typedef struct {
    // Raw data
    packet_t packets[MAX_PACKETS];
    int packet_count;

    // Bursts
    burst_t bursts[MAX_BURSTS];
    int burst_count;

    // Statistics
    uint64_t total_bytes;
    uint64_t first_ts;
    uint64_t last_ts;

    // CBS estimation
    double measured_bps;          // Actual throughput
    double estimated_idle_slope;  // Estimated idle slope
    double burst_ratio;           // Burst vs total time
    bool is_shaped;               // Detected as CBS shaped

    // Burst timing
    double avg_burst_duration_us;
    double avg_gap_duration_us;
    double max_burst_bytes;
} tc_analysis_t;

// Global state
static volatile int running = 1;
static tc_analysis_t tc_data[MAX_TC];
static int target_vlan = 100;
static double link_speed_bps = 100000000.0;  // Default 100 Mbps
static pcap_t *handle = NULL;
static pthread_mutex_t data_mutex = PTHREAD_MUTEX_INITIALIZER;

// Burst detection threshold (microseconds gap = new burst)
#define BURST_GAP_THRESHOLD_US 500

static uint64_t get_time_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

static void signal_handler(int sig) {
    (void)sig;
    running = 0;
    if (handle) pcap_breakloop(handle);
}

// Packet handler - collect raw data
static void packet_handler(u_char *user, const struct pcap_pkthdr *hdr, const u_char *pkt) {
    (void)user;

    if (hdr->caplen < 18) return;

    // Check VLAN
    uint16_t ethertype = (pkt[12] << 8) | pkt[13];
    if (ethertype != 0x8100) return;

    uint16_t tci = (pkt[14] << 8) | pkt[15];
    int pcp = (tci >> 13) & 0x07;
    int vid = tci & 0x0FFF;

    if (target_vlan > 0 && vid != target_vlan) return;

    // Timestamp in nanoseconds
    uint64_t ts_ns = (uint64_t)hdr->ts.tv_sec * 1000000000ULL +
                     (uint64_t)hdr->ts.tv_usec * 1000ULL;

    pthread_mutex_lock(&data_mutex);

    tc_analysis_t *tc = &tc_data[pcp];
    if (tc->packet_count < MAX_PACKETS) {
        packet_t *p = &tc->packets[tc->packet_count];
        p->ts_ns = ts_ns;
        p->len = hdr->len;
        p->tc = pcp;
        tc->packet_count++;
        tc->total_bytes += hdr->len;

        if (tc->first_ts == 0) tc->first_ts = ts_ns;
        tc->last_ts = ts_ns;
    }

    pthread_mutex_unlock(&data_mutex);
}

// Detect bursts in packet stream
static void detect_bursts(tc_analysis_t *tc) {
    if (tc->packet_count < 2) return;

    uint64_t gap_threshold = BURST_GAP_THRESHOLD_US * 1000;  // to ns

    // Start first burst
    burst_t *b = &tc->bursts[0];
    b->start_ns = tc->packets[0].ts_ns;
    b->bytes = tc->packets[0].len;
    b->packets = 1;
    tc->burst_count = 1;

    for (int i = 1; i < tc->packet_count; i++) {
        uint64_t gap = tc->packets[i].ts_ns - tc->packets[i-1].ts_ns;

        if (gap > gap_threshold && tc->burst_count < MAX_BURSTS) {
            // End current burst
            b->end_ns = tc->packets[i-1].ts_ns;

            // Start new burst
            tc->burst_count++;
            b = &tc->bursts[tc->burst_count - 1];
            b->start_ns = tc->packets[i].ts_ns;
            b->bytes = tc->packets[i].len;
            b->packets = 1;
        } else {
            // Continue burst
            b->bytes += tc->packets[i].len;
            b->packets++;
        }
    }

    // End last burst
    b->end_ns = tc->packets[tc->packet_count - 1].ts_ns;
}

// Analyze bursts and estimate CBS parameters
static void analyze_cbs(tc_analysis_t *tc) {
    if (tc->packet_count < 10 || tc->burst_count < 1) return;

    // Calculate total duration
    double total_duration_s = (tc->last_ts - tc->first_ts) / 1e9;
    if (total_duration_s <= 0) return;

    // Measured throughput
    tc->measured_bps = (tc->total_bytes * 8.0) / total_duration_s;

    // Analyze burst patterns
    double total_burst_time = 0;
    double total_gap_time = 0;
    double max_burst = 0;

    for (int i = 0; i < tc->burst_count; i++) {
        burst_t *b = &tc->bursts[i];
        double burst_dur = (b->end_ns - b->start_ns) / 1e3;  // microseconds
        total_burst_time += burst_dur;

        if (b->bytes > max_burst) max_burst = b->bytes;

        // Gap to next burst
        if (i < tc->burst_count - 1) {
            double gap = (tc->bursts[i+1].start_ns - b->end_ns) / 1e3;
            total_gap_time += gap;
        }
    }

    tc->max_burst_bytes = max_burst;
    tc->avg_burst_duration_us = tc->burst_count > 0 ?
        total_burst_time / tc->burst_count : 0;
    tc->avg_gap_duration_us = tc->burst_count > 1 ?
        total_gap_time / (tc->burst_count - 1) : 0;

    // Calculate burst ratio
    double total_time_us = total_duration_s * 1e6;
    tc->burst_ratio = total_burst_time / total_time_us;

    /*
     * CBS Detection Heuristics:
     *
     * Shaped traffic characteristics:
     * - Regular burst patterns with gaps
     * - burst_ratio < 0.9 (not continuous)
     * - Consistent inter-burst gaps
     * - Limited max burst size (hiCredit effect)
     *
     * Unshaped traffic:
     * - Near-continuous transmission
     * - burst_ratio close to 1.0
     * - No regular gaps
     */

    // Check for shaping indicators
    bool has_gaps = tc->avg_gap_duration_us > 100;  // > 100us gaps
    bool regular_bursts = tc->burst_count > 3;
    bool limited_burst = tc->max_burst_bytes < 10000;  // bytes

    tc->is_shaped = has_gaps && regular_bursts && (tc->burst_ratio < 0.85);

    /*
     * Idle Slope Estimation:
     *
     * For CBS: idleSlope determines the allocated bandwidth
     * When traffic is saturated, measured throughput ≈ idleSlope / link_speed
     *
     * If shaped: idleSlope ≈ measured_bps (allocated bandwidth)
     * If unshaped: idleSlope estimation not reliable
     */

    if (tc->is_shaped) {
        // For shaped traffic, measured throughput reflects idle slope
        tc->estimated_idle_slope = tc->measured_bps;
    } else {
        // Unshaped - estimate based on ratio of link speed
        // This is less accurate
        tc->estimated_idle_slope = tc->measured_bps;
    }
}

// Print JSON results
static void print_results_json(void) {
    printf("{\n");
    printf("  \"type\": \"cbs_estimation\",\n");
    printf("  \"link_speed_mbps\": %.0f,\n", link_speed_bps / 1e6);
    printf("  \"vlan\": %d,\n", target_vlan);
    printf("  \"tc\": {\n");

    int first = 1;
    for (int i = 0; i < MAX_TC; i++) {
        tc_analysis_t *tc = &tc_data[i];
        if (tc->packet_count < 10) continue;

        if (!first) printf(",\n");
        first = 0;

        printf("    \"%d\": {\n", i);
        printf("      \"packets\": %d,\n", tc->packet_count);
        printf("      \"bytes\": %lu,\n", tc->total_bytes);
        printf("      \"duration_ms\": %.1f,\n", (tc->last_ts - tc->first_ts) / 1e6);
        printf("      \"measured_kbps\": %.1f,\n", tc->measured_bps / 1000.0);
        printf("      \"measured_mbps\": %.3f,\n", tc->measured_bps / 1e6);
        printf("      \"bursts\": %d,\n", tc->burst_count);
        printf("      \"avg_burst_us\": %.1f,\n", tc->avg_burst_duration_us);
        printf("      \"avg_gap_us\": %.1f,\n", tc->avg_gap_duration_us);
        printf("      \"max_burst_bytes\": %.0f,\n", tc->max_burst_bytes);
        printf("      \"burst_ratio\": %.3f,\n", tc->burst_ratio);
        printf("      \"is_shaped\": %s,\n", tc->is_shaped ? "true" : "false");
        printf("      \"estimated_idle_slope_bps\": %.0f,\n", tc->estimated_idle_slope);
        printf("      \"estimated_idle_slope_kbps\": %.1f,\n", tc->estimated_idle_slope / 1000.0);
        printf("      \"bandwidth_percent\": %.2f\n", (tc->estimated_idle_slope / link_speed_bps) * 100.0);
        printf("    }");
    }

    printf("\n  },\n");

    // CBS configuration recommendation
    printf("  \"cbs_config\": [\n");
    first = 1;
    for (int i = 0; i < MAX_TC; i++) {
        tc_analysis_t *tc = &tc_data[i];
        if (tc->packet_count < 10) continue;

        if (!first) printf(",\n");
        first = 0;

        // Calculate recommended CBS parameters
        double idle_slope = tc->estimated_idle_slope;
        double send_slope = -(link_speed_bps - idle_slope);
        double hi_credit = tc->max_burst_bytes * 1.5;  // Add margin
        double lo_credit = -hi_credit;  // Symmetric

        printf("    {\n");
        printf("      \"tc\": %d,\n", i);
        printf("      \"idle_slope_bps\": %.0f,\n", idle_slope);
        printf("      \"send_slope_bps\": %.0f,\n", send_slope);
        printf("      \"hi_credit_bytes\": %.0f,\n", hi_credit);
        printf("      \"lo_credit_bytes\": %.0f,\n", lo_credit);
        printf("      \"confidence\": \"%s\"\n", tc->is_shaped ? "high" : "low");
        printf("    }");
    }
    printf("\n  ]\n");
    printf("}\n");
}

static void print_results_human(void) {
    printf("\n");
    printf("╔════════════════════════════════════════════════════════════════╗\n");
    printf("║           CBS (Credit-Based Shaper) Estimation Results         ║\n");
    printf("╚════════════════════════════════════════════════════════════════╝\n");
    printf("\n");
    printf("Link Speed: %.0f Mbps    VLAN: %d\n\n", link_speed_bps / 1e6, target_vlan);

    printf("┌────┬──────────┬──────────┬────────┬─────────┬──────────┬─────────┐\n");
    printf("│ TC │  Packets │  Kbps    │ Bursts │ Shaped  │ IdleSlope│ BW %%    │\n");
    printf("├────┼──────────┼──────────┼────────┼─────────┼──────────┼─────────┤\n");

    for (int i = 0; i < MAX_TC; i++) {
        tc_analysis_t *tc = &tc_data[i];
        if (tc->packet_count < 10) continue;

        printf("│ %2d │ %8d │ %8.1f │ %6d │   %s   │ %8.0f │ %6.2f%% │\n",
               i, tc->packet_count, tc->measured_bps / 1000.0,
               tc->burst_count, tc->is_shaped ? "YES" : " NO",
               tc->estimated_idle_slope / 1000.0,
               (tc->estimated_idle_slope / link_speed_bps) * 100.0);
    }

    printf("└────┴──────────┴──────────┴────────┴─────────┴──────────┴─────────┘\n");

    printf("\n");
    printf("Recommended CBS Configuration:\n");
    printf("─────────────────────────────────────────────────────────────────\n");

    for (int i = 0; i < MAX_TC; i++) {
        tc_analysis_t *tc = &tc_data[i];
        if (tc->packet_count < 10) continue;

        double idle_slope = tc->estimated_idle_slope;
        double send_slope = -(link_speed_bps - idle_slope);
        double hi_credit = tc->max_burst_bytes * 1.5;

        printf("TC%d: idleSlope=%8.0f bps, sendSlope=%9.0f bps, hiCredit=%6.0f bytes",
               i, idle_slope, send_slope, hi_credit);
        printf("  [%s]\n", tc->is_shaped ? "SHAPED" : "UNSHAPED");
    }
    printf("\n");
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "CBS Idle Slope Estimator\n");
        fprintf(stderr, "Usage: %s <interface> <duration_sec> [vlan_id] [link_speed_mbps]\n", argv[0]);
        fprintf(stderr, "Example: %s enxc84d44263ba6 10 100 100\n", argv[0]);
        return 1;
    }

    const char *ifname = argv[1];
    int duration = atoi(argv[2]);
    target_vlan = argc > 3 ? atoi(argv[3]) : 100;
    if (argc > 4) {
        link_speed_bps = atof(argv[4]) * 1e6;
    }

    // Initialize
    memset(tc_data, 0, sizeof(tc_data));
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Open capture
    char errbuf[PCAP_ERRBUF_SIZE];
    handle = pcap_open_live(ifname, 128, 1, 1, errbuf);
    if (!handle) {
        fprintf(stderr, "Error: %s\n", errbuf);
        return 1;
    }

    // VLAN filter
    struct bpf_program fp;
    char filter[64];
    snprintf(filter, sizeof(filter), "vlan %d", target_vlan);
    if (pcap_compile(handle, &fp, filter, 1, PCAP_NETMASK_UNKNOWN) == 0) {
        pcap_setfilter(handle, &fp);
        pcap_freecode(&fp);
    }

    fprintf(stderr, "Capturing on %s for %d seconds (VLAN %d)...\n",
            ifname, duration, target_vlan);

    // Capture packets
    uint64_t start = get_time_ns();
    uint64_t end = start + (uint64_t)duration * 1000000000ULL;

    while (running && get_time_ns() < end) {
        pcap_dispatch(handle, 100, packet_handler, NULL);
    }

    pcap_close(handle);

    fprintf(stderr, "Analyzing captured data...\n");

    // Analyze each TC
    for (int i = 0; i < MAX_TC; i++) {
        if (tc_data[i].packet_count > 0) {
            detect_bursts(&tc_data[i]);
            analyze_cbs(&tc_data[i]);
        }
    }

    // Output
    if (isatty(STDOUT_FILENO)) {
        print_results_human();
    } else {
        print_results_json();
    }

    return 0;
}
