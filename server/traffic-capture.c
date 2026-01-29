/*
 * traffic-capture.c - High-precision packet capture for TSN analysis
 * Using libpcap for reliable capture
 *
 * Compile: gcc -O2 -o traffic-capture traffic-capture.c -lpcap -lpthread -lm
 * Run: sudo ./traffic-capture <interface> [duration] [vlan_id] [output_mode]
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <math.h>
#include <sys/mman.h>
#include <sched.h>
#include <pthread.h>
#include <pcap/pcap.h>

#define MAX_TC 8
#define MAX_PACKETS_PER_TC 50000
#define STATS_INTERVAL_MS 200

// Per-TC statistics
typedef struct {
    uint64_t count;
    uint64_t first_ts_us;
    uint64_t last_ts_us;
    uint64_t total_interval_us;
    uint64_t min_interval_us;
    uint64_t max_interval_us;
    uint64_t intervals[MAX_PACKETS_PER_TC];
    int interval_count;
} tc_stats_t;

// Global state
static volatile int running = 1;
static tc_stats_t tc_stats[MAX_TC];
static uint64_t total_packets = 0;
static uint64_t start_time_us = 0;
static int target_vlan = 100;
static int output_mode = 0;  // 0=json, 1=stats, 2=raw
static pthread_mutex_t stats_mutex = PTHREAD_MUTEX_INITIALIZER;
static pcap_t *handle = NULL;

// Get current time in microseconds
static uint64_t get_time_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ULL + ts.tv_nsec / 1000;
}

// Signal handler
static void signal_handler(int sig) {
    (void)sig;
    running = 0;
    if (handle) pcap_breakloop(handle);
}

// Setup real-time scheduling
static void setup_realtime(void) {
    struct sched_param param;
    param.sched_priority = sched_get_priority_max(SCHED_FIFO) - 1;
    if (sched_setscheduler(0, SCHED_FIFO, &param) < 0) {
        // Not critical
    }
    mlockall(MCL_CURRENT | MCL_FUTURE);
}

// Packet handler callback
static void packet_handler(u_char *user, const struct pcap_pkthdr *hdr, const u_char *pkt) {
    (void)user;

    if (hdr->caplen < 18) return;

    // Timestamp from pcap (microseconds)
    uint64_t ts_us = (uint64_t)hdr->ts.tv_sec * 1000000ULL + hdr->ts.tv_usec;

    // Check for VLAN tag (ethertype at offset 12)
    uint16_t ethertype = (pkt[12] << 8) | pkt[13];
    if (ethertype != 0x8100) return;

    // Parse VLAN TCI (offset 14-15)
    uint16_t tci = (pkt[14] << 8) | pkt[15];
    int pcp = (tci >> 13) & 0x07;
    int vid = tci & 0x0FFF;

    // Filter by VLAN ID
    if (target_vlan > 0 && vid != target_vlan) return;

    // Filter by inner protocol - must be IPv4 UDP
    uint16_t inner_proto = (pkt[16] << 8) | pkt[17];
    if (inner_proto != 0x0800) return;  // Not IPv4

    // Update statistics
    pthread_mutex_lock(&stats_mutex);

    tc_stats_t *tc = &tc_stats[pcp];

    if (tc->count == 0) {
        tc->first_ts_us = ts_us;
        tc->min_interval_us = UINT64_MAX;
    } else {
        uint64_t interval = ts_us - tc->last_ts_us;
        tc->total_interval_us += interval;

        if (interval < tc->min_interval_us) tc->min_interval_us = interval;
        if (interval > tc->max_interval_us) tc->max_interval_us = interval;

        if (tc->interval_count < MAX_PACKETS_PER_TC) {
            tc->intervals[tc->interval_count++] = interval;
        }
    }

    tc->last_ts_us = ts_us;
    tc->count++;
    total_packets++;

    pthread_mutex_unlock(&stats_mutex);

    // Raw output
    if (output_mode == 2) {
        printf("%lu.%06lu TC%d VID%d len=%d\n",
               ts_us / 1000000, ts_us % 1000000, pcp, vid, hdr->len);
        fflush(stdout);
    }
}

// Print JSON stats
static void print_stats_json(void) {
    uint64_t now = get_time_us();
    uint64_t elapsed_us = now - start_time_us;

    pthread_mutex_lock(&stats_mutex);

    printf("{\"elapsed_ms\":%.1f,\"total\":%lu,\"tc\":{",
           elapsed_us / 1000.0, total_packets);

    int first = 1;
    for (int i = 0; i < MAX_TC; i++) {
        tc_stats_t *tc = &tc_stats[i];
        if (tc->count == 0) continue;

        double avg_interval = tc->count > 1 ?
            (double)tc->total_interval_us / (tc->count - 1) : 0;
        double throughput_kbps = tc->count > 1 && tc->last_ts_us > tc->first_ts_us ?
            (tc->count * 60.0 * 8.0 * 1000.0) / (tc->last_ts_us - tc->first_ts_us) : 0;

        if (!first) printf(",");
        first = 0;

        printf("\"%d\":{\"count\":%lu,\"avg_us\":%.1f,\"min_us\":%lu,\"max_us\":%lu,\"kbps\":%.1f}",
               i, tc->count, avg_interval,
               tc->min_interval_us == UINT64_MAX ? 0 : tc->min_interval_us,
               tc->max_interval_us, throughput_kbps);
    }

    printf("}}\n");
    fflush(stdout);

    pthread_mutex_unlock(&stats_mutex);
}

// Print human-readable stats
static void print_stats_human(void) {
    uint64_t now = get_time_us();
    uint64_t elapsed_us = now - start_time_us;

    pthread_mutex_lock(&stats_mutex);

    printf("\n=== Capture Stats (%.1f sec) ===\n", elapsed_us / 1000000.0);
    printf("Total: %lu packets\n\n", total_packets);
    printf("TC  Count     Avg(ms)   Min(ms)   Max(ms)   Throughput\n");
    printf("----------------------------------------------------\n");

    for (int i = 0; i < MAX_TC; i++) {
        tc_stats_t *tc = &tc_stats[i];
        if (tc->count == 0) continue;

        double avg_ms = tc->count > 1 ?
            (double)tc->total_interval_us / (tc->count - 1) / 1000.0 : 0;
        double min_ms = tc->min_interval_us == UINT64_MAX ? 0 : tc->min_interval_us / 1000.0;
        double max_ms = tc->max_interval_us / 1000.0;
        double kbps = tc->count > 1 && tc->last_ts_us > tc->first_ts_us ?
            (tc->count * 60.0 * 8.0 * 1000.0) / (tc->last_ts_us - tc->first_ts_us) : 0;

        printf("TC%d %8lu %9.2f %9.2f %9.2f %8.1f kbps\n",
               i, tc->count, avg_ms, min_ms, max_ms, kbps);
    }

    pthread_mutex_unlock(&stats_mutex);
}

// Print final analysis
static void print_final_analysis(void) {
    pthread_mutex_lock(&stats_mutex);

    printf("\n{\"final\":true,\"tc\":{");

    int first_tc = 1;
    for (int i = 0; i < MAX_TC; i++) {
        tc_stats_t *tc = &tc_stats[i];
        if (tc->count < 2) continue;

        double avg = (double)tc->total_interval_us / (tc->count - 1);

        // Calculate stddev and burst analysis
        double sum_sq = 0;
        int burst_count = 0;
        uint64_t burst_threshold = 1000;  // 1ms

        for (int j = 0; j < tc->interval_count; j++) {
            double diff = (double)tc->intervals[j] - avg;
            sum_sq += diff * diff;
            if (tc->intervals[j] < burst_threshold) burst_count++;
        }

        double stddev = tc->interval_count > 0 ? sqrt(sum_sq / tc->interval_count) : 0;
        int is_shaped = (stddev > avg * 0.3) || (burst_count > tc->interval_count / 3);

        double kbps = (tc->count * 60.0 * 8.0 * 1000.0) / (tc->last_ts_us - tc->first_ts_us);

        if (!first_tc) printf(",");
        first_tc = 0;

        printf("\"%d\":{\"count\":%lu,\"avg_ms\":%.2f,\"min_ms\":%.2f,\"max_ms\":%.2f,"
               "\"stddev_ms\":%.2f,\"kbps\":%.1f,\"burst\":%d,\"shaped\":%s}",
               i, tc->count, avg/1000.0,
               tc->min_interval_us == UINT64_MAX ? 0 : tc->min_interval_us/1000.0,
               tc->max_interval_us/1000.0, stddev/1000.0, kbps, burst_count,
               is_shaped ? "true" : "false");
    }

    printf("}}\n");
    fflush(stdout);

    pthread_mutex_unlock(&stats_mutex);
}

// Stats thread
static void *stats_thread(void *arg) {
    (void)arg;
    while (running) {
        usleep(STATS_INTERVAL_MS * 1000);
        if (!running) break;
        if (output_mode == 0) print_stats_json();
        else if (output_mode == 1) print_stats_human();
    }
    return NULL;
}

static void usage(const char *prog) {
    fprintf(stderr, "Usage: %s <interface> [duration] [vlan_id] [mode]\n", prog);
    fprintf(stderr, "  mode: json (default), stats, raw\n");
    fprintf(stderr, "Example: %s enxc84d44231cc2 5 100 json\n", prog);
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        usage(argv[0]);
        return 1;
    }

    const char *ifname = argv[1];
    int duration = argc > 2 ? atoi(argv[2]) : 10;
    target_vlan = argc > 3 ? atoi(argv[3]) : 100;

    if (argc > 4) {
        if (strcmp(argv[4], "stats") == 0) output_mode = 1;
        else if (strcmp(argv[4], "raw") == 0) output_mode = 2;
    }

    // Initialize
    memset(tc_stats, 0, sizeof(tc_stats));
    for (int i = 0; i < MAX_TC; i++) {
        tc_stats[i].min_interval_us = UINT64_MAX;
    }

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    setup_realtime();

    // Open pcap
    char errbuf[PCAP_ERRBUF_SIZE];
    handle = pcap_open_live(ifname, 128, 1, 10, errbuf);
    if (!handle) {
        fprintf(stderr, "pcap_open_live: %s\n", errbuf);
        return 1;
    }

    // Set filter for VLAN
    struct bpf_program fp;
    char filter[64];
    snprintf(filter, sizeof(filter), "vlan %d", target_vlan);
    if (pcap_compile(handle, &fp, filter, 1, PCAP_NETMASK_UNKNOWN) == 0) {
        pcap_setfilter(handle, &fp);
        pcap_freecode(&fp);
    }

    fprintf(stderr, "Capturing on %s, VLAN %d, %ds, mode=%s\n",
            ifname, target_vlan, duration,
            output_mode == 0 ? "json" : (output_mode == 1 ? "stats" : "raw"));

    // Start stats thread
    pthread_t stats_tid;
    if (output_mode != 2) {
        pthread_create(&stats_tid, NULL, stats_thread, NULL);
    }

    // Capture
    start_time_us = get_time_us();
    uint64_t end_time_us = duration > 0 ? start_time_us + duration * 1000000ULL : UINT64_MAX;

    while (running && get_time_us() < end_time_us) {
        pcap_dispatch(handle, 100, packet_handler, NULL);
    }

    running = 0;

    // Cleanup
    if (output_mode != 2) {
        pthread_join(stats_tid, NULL);
    }
    pcap_close(handle);

    // Final output
    if (output_mode == 0) {
        print_final_analysis();
    } else if (output_mode == 1) {
        print_stats_human();
    }

    return 0;
}
