/*
 * TAS GCL (Gate Control List) Estimator
 * Estimates IEEE 802.1Qbv Time-Aware Shaper configuration from traffic
 *
 * IEEE 802.1Qbv TAS Parameters:
 *   - cycleTime: Total cycle duration (nanoseconds)
 *   - GCL: List of (gateStates, timeInterval) entries
 *   - gateStates: 8-bit mask, bit N = gate for TC N
 *
 * Estimation Method:
 *   1. Capture traffic and record precise timestamps per TC
 *   2. Detect periodic patterns using autocorrelation
 *   3. Estimate cycle time from periodicity
 *   4. Map traffic presence to gate open windows
 *   5. Generate GCL from detected windows
 *
 * Compile: gcc -O2 -o tas-estimator tas-estimator.c -lpcap -lpthread -lm -lfftw3
 *          (or without FFTW: gcc -O2 -o tas-estimator tas-estimator.c -lpcap -lpthread -lm -DNO_FFTW)
 * Run: sudo ./tas-estimator <interface> <duration> <vlan_id> [expected_cycle_ms]
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
#include <pcap/pcap.h>
#include <pthread.h>

#define MAX_TC 8
#define MAX_PACKETS 200000
#define MAX_GCL_ENTRIES 64
#define HISTOGRAM_BINS 2000
#define TIME_BIN_US 100  // 100 microsecond bins

// Packet record
typedef struct {
    uint64_t ts_ns;
    uint16_t len;
} packet_t;

// GCL entry
typedef struct {
    uint8_t gate_states;   // Bit mask for open gates
    uint32_t time_ns;      // Duration of this entry
} gcl_entry_t;

// Gate window (detected open period)
typedef struct {
    uint64_t start_offset_ns;  // Offset from cycle start
    uint64_t duration_ns;      // Duration of open window
    int tc;
} gate_window_t;

// Per-TC data
typedef struct {
    packet_t packets[MAX_PACKETS];
    int packet_count;
    uint64_t first_ts;
    uint64_t last_ts;

    // Time histogram (packets per time bin within cycle)
    int histogram[HISTOGRAM_BINS];
    int histogram_size;

    // Detected windows
    gate_window_t windows[16];
    int window_count;

    // Statistics
    double avg_interval_us;
    double stddev_interval_us;
} tc_data_t;

// Global state
static volatile int running = 1;
static tc_data_t tc_data[MAX_TC];
static int target_vlan = 100;
static double expected_cycle_ms = 0;  // 0 = auto-detect
static pcap_t *handle = NULL;
static pthread_mutex_t data_mutex = PTHREAD_MUTEX_INITIALIZER;

// Estimated TAS parameters
static uint64_t estimated_cycle_ns = 0;
static gcl_entry_t estimated_gcl[MAX_GCL_ENTRIES];
static int estimated_gcl_size = 0;

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

// Packet handler
static void packet_handler(u_char *user, const struct pcap_pkthdr *hdr, const u_char *pkt) {
    (void)user;
    if (hdr->caplen < 18) return;

    uint16_t ethertype = (pkt[12] << 8) | pkt[13];
    if (ethertype != 0x8100) return;

    uint16_t tci = (pkt[14] << 8) | pkt[15];
    int pcp = (tci >> 13) & 0x07;
    int vid = tci & 0x0FFF;

    if (target_vlan > 0 && vid != target_vlan) return;

    uint64_t ts_ns = (uint64_t)hdr->ts.tv_sec * 1000000000ULL +
                     (uint64_t)hdr->ts.tv_usec * 1000ULL;

    pthread_mutex_lock(&data_mutex);

    tc_data_t *tc = &tc_data[pcp];
    if (tc->packet_count < MAX_PACKETS) {
        packet_t *p = &tc->packets[tc->packet_count];
        p->ts_ns = ts_ns;
        p->len = hdr->len;
        tc->packet_count++;

        if (tc->first_ts == 0) tc->first_ts = ts_ns;
        tc->last_ts = ts_ns;
    }

    pthread_mutex_unlock(&data_mutex);
}

// Calculate interval statistics
static void calc_interval_stats(tc_data_t *tc) {
    if (tc->packet_count < 3) return;

    double sum = 0;
    double sum_sq = 0;
    int count = 0;

    for (int i = 1; i < tc->packet_count; i++) {
        double interval = (tc->packets[i].ts_ns - tc->packets[i-1].ts_ns) / 1000.0;
        if (interval < 1000000) {  // Ignore huge gaps (> 1 sec)
            sum += interval;
            sum_sq += interval * interval;
            count++;
        }
    }

    if (count > 0) {
        tc->avg_interval_us = sum / count;
        double variance = (sum_sq / count) - (tc->avg_interval_us * tc->avg_interval_us);
        tc->stddev_interval_us = variance > 0 ? sqrt(variance) : 0;
    }
}

// Detect cycle time using autocorrelation of packet intervals
static uint64_t detect_cycle_time(void) {
    // Try common TAS cycle times: 100us to 500ms
    uint64_t candidate_cycles[] = {
        100000,      // 100 us
        500000,      // 500 us
        1000000,     // 1 ms
        2000000,     // 2 ms
        5000000,     // 5 ms
        10000000,    // 10 ms
        20000000,    // 20 ms
        50000000,    // 50 ms
        100000000,   // 100 ms
        200000000,   // 200 ms
        500000000,   // 500 ms
    };
    int n_candidates = sizeof(candidate_cycles) / sizeof(candidate_cycles[0]);

    double best_score = 0;
    uint64_t best_cycle = 0;

    // Test each candidate cycle time
    for (int c = 0; c < n_candidates; c++) {
        uint64_t cycle = candidate_cycles[c];
        double total_score = 0;
        int tc_count = 0;

        // For each TC with data
        for (int t = 0; t < MAX_TC; t++) {
            tc_data_t *tc = &tc_data[t];
            if (tc->packet_count < 100) continue;

            tc_count++;

            // Build histogram of packet positions within cycle
            int bins[100] = {0};
            int n_bins = 100;
            uint64_t bin_size = cycle / n_bins;

            for (int i = 0; i < tc->packet_count; i++) {
                uint64_t offset = (tc->packets[i].ts_ns - tc->first_ts) % cycle;
                int bin = (offset / bin_size) % n_bins;
                bins[bin]++;
            }

            // Calculate variance of histogram (higher = more periodic)
            double mean = (double)tc->packet_count / n_bins;
            double variance = 0;
            for (int b = 0; b < n_bins; b++) {
                double diff = bins[b] - mean;
                variance += diff * diff;
            }
            variance /= n_bins;

            // Normalize by mean squared
            double score = variance / (mean * mean + 0.001);
            total_score += score;
        }

        if (tc_count > 0) {
            total_score /= tc_count;
            if (total_score > best_score) {
                best_score = total_score;
                best_cycle = cycle;
            }
        }
    }

    // If expected cycle provided, use it
    if (expected_cycle_ms > 0) {
        best_cycle = (uint64_t)(expected_cycle_ms * 1e6);
    }

    return best_cycle;
}

// Build histogram for a TC with detected cycle time
static void build_histogram(tc_data_t *tc, uint64_t cycle_ns) {
    if (tc->packet_count < 10 || cycle_ns == 0) return;

    int n_bins = HISTOGRAM_BINS;
    uint64_t bin_size = cycle_ns / n_bins;
    if (bin_size == 0) bin_size = 1;

    memset(tc->histogram, 0, sizeof(tc->histogram));
    tc->histogram_size = n_bins < HISTOGRAM_BINS ? n_bins : HISTOGRAM_BINS;

    for (int i = 0; i < tc->packet_count; i++) {
        uint64_t offset = (tc->packets[i].ts_ns - tc->first_ts) % cycle_ns;
        int bin = (offset / bin_size) % tc->histogram_size;
        tc->histogram[bin]++;
    }
}

// Detect gate windows from histogram
static void detect_windows(tc_data_t *tc, uint64_t cycle_ns, int tc_idx) {
    if (tc->histogram_size == 0 || tc->packet_count < 10) return;

    // Find threshold (packets present vs absent)
    double mean = (double)tc->packet_count * 2.0 / tc->histogram_size;
    int threshold = (int)(mean * 0.3);  // 30% of mean
    if (threshold < 1) threshold = 1;

    uint64_t bin_size = cycle_ns / tc->histogram_size;

    // Scan for windows
    tc->window_count = 0;
    bool in_window = false;
    int window_start = 0;

    for (int i = 0; i <= tc->histogram_size; i++) {
        int bin_val = (i < tc->histogram_size) ? tc->histogram[i] : 0;
        bool has_traffic = bin_val >= threshold;

        if (has_traffic && !in_window) {
            // Window starts
            in_window = true;
            window_start = i;
        } else if (!has_traffic && in_window) {
            // Window ends
            in_window = false;
            if (tc->window_count < 16) {
                gate_window_t *w = &tc->windows[tc->window_count];
                w->tc = tc_idx;
                w->start_offset_ns = (uint64_t)window_start * bin_size;
                w->duration_ns = (uint64_t)(i - window_start) * bin_size;
                tc->window_count++;
            }
        }
    }

    // Handle wrap-around (window that spans cycle boundary)
    if (in_window && tc->window_count > 0 && tc->histogram[0] >= threshold) {
        // Merge with first window
        gate_window_t *last = &tc->windows[tc->window_count - 1];
        gate_window_t *first = &tc->windows[0];
        first->start_offset_ns = last->start_offset_ns;
        first->duration_ns = last->duration_ns + first->duration_ns;
        if (first->duration_ns > cycle_ns) first->duration_ns = cycle_ns;
        tc->window_count--;
    }
}

// Merge windows into GCL
static void build_gcl(uint64_t cycle_ns) {
    // Collect all window boundaries
    typedef struct {
        uint64_t time;
        int tc;
        bool is_start;
    } event_t;

    event_t events[MAX_TC * 32];
    int n_events = 0;

    for (int t = 0; t < MAX_TC; t++) {
        tc_data_t *tc = &tc_data[t];
        for (int w = 0; w < tc->window_count; w++) {
            gate_window_t *win = &tc->windows[w];
            events[n_events].time = win->start_offset_ns;
            events[n_events].tc = t;
            events[n_events].is_start = true;
            n_events++;

            events[n_events].time = (win->start_offset_ns + win->duration_ns) % cycle_ns;
            events[n_events].tc = t;
            events[n_events].is_start = false;
            n_events++;
        }
    }

    // Sort events by time
    for (int i = 0; i < n_events - 1; i++) {
        for (int j = i + 1; j < n_events; j++) {
            if (events[j].time < events[i].time) {
                event_t tmp = events[i];
                events[i] = events[j];
                events[j] = tmp;
            }
        }
    }

    // Build GCL from events
    uint8_t current_gates = 0;

    // Start with all gates closed, find initial state
    for (int t = 0; t < MAX_TC; t++) {
        tc_data_t *tc = &tc_data[t];
        for (int w = 0; w < tc->window_count; w++) {
            gate_window_t *win = &tc->windows[w];
            if (win->start_offset_ns == 0 ||
                (win->start_offset_ns + win->duration_ns > cycle_ns)) {
                current_gates |= (1 << t);
            }
        }
    }

    estimated_gcl_size = 0;
    uint64_t last_time = 0;

    for (int e = 0; e < n_events && estimated_gcl_size < MAX_GCL_ENTRIES; e++) {
        // Skip duplicate times
        if (e > 0 && events[e].time == events[e-1].time) {
            // Just update gate state
            if (events[e].is_start) {
                current_gates |= (1 << events[e].tc);
            } else {
                current_gates &= ~(1 << events[e].tc);
            }
            continue;
        }

        if (events[e].time > last_time) {
            // Add GCL entry
            estimated_gcl[estimated_gcl_size].gate_states = current_gates;
            estimated_gcl[estimated_gcl_size].time_ns = events[e].time - last_time;
            estimated_gcl_size++;
            last_time = events[e].time;
        }

        // Update gate state
        if (events[e].is_start) {
            current_gates |= (1 << events[e].tc);
        } else {
            current_gates &= ~(1 << events[e].tc);
        }
    }

    // Final entry to complete cycle
    if (last_time < cycle_ns && estimated_gcl_size < MAX_GCL_ENTRIES) {
        estimated_gcl[estimated_gcl_size].gate_states = current_gates;
        estimated_gcl[estimated_gcl_size].time_ns = cycle_ns - last_time;
        estimated_gcl_size++;
    }

    // Merge consecutive entries with same gate state
    int merged = 0;
    for (int i = 0; i < estimated_gcl_size; i++) {
        if (merged > 0 &&
            estimated_gcl[merged-1].gate_states == estimated_gcl[i].gate_states) {
            estimated_gcl[merged-1].time_ns += estimated_gcl[i].time_ns;
        } else {
            estimated_gcl[merged++] = estimated_gcl[i];
        }
    }
    estimated_gcl_size = merged;
}

// Print JSON results
static void print_results_json(void) {
    printf("{\n");
    printf("  \"type\": \"tas_estimation\",\n");
    printf("  \"vlan\": %d,\n", target_vlan);
    printf("  \"estimated_cycle_ns\": %lu,\n", estimated_cycle_ns);
    printf("  \"estimated_cycle_ms\": %.3f,\n", estimated_cycle_ns / 1e6);

    // Per-TC statistics
    printf("  \"tc\": {\n");
    int first = 1;
    for (int t = 0; t < MAX_TC; t++) {
        tc_data_t *tc = &tc_data[t];
        if (tc->packet_count < 10) continue;

        if (!first) printf(",\n");
        first = 0;

        printf("    \"%d\": {\n", t);
        printf("      \"packets\": %d,\n", tc->packet_count);
        printf("      \"avg_interval_us\": %.1f,\n", tc->avg_interval_us);
        printf("      \"stddev_us\": %.1f,\n", tc->stddev_interval_us);
        printf("      \"windows\": [\n");
        for (int w = 0; w < tc->window_count; w++) {
            gate_window_t *win = &tc->windows[w];
            printf("        {\"start_us\": %.1f, \"duration_us\": %.1f}%s\n",
                   win->start_offset_ns / 1000.0, win->duration_ns / 1000.0,
                   w < tc->window_count - 1 ? "," : "");
        }
        printf("      ]\n");
        printf("    }");
    }
    printf("\n  },\n");

    // GCL
    printf("  \"gcl\": [\n");
    for (int i = 0; i < estimated_gcl_size; i++) {
        gcl_entry_t *e = &estimated_gcl[i];
        char gates[9];
        for (int b = 7; b >= 0; b--) {
            gates[7-b] = (e->gate_states & (1 << b)) ? '1' : '0';
        }
        gates[8] = '\0';

        printf("    {\"gate_states\": \"%s\", \"gate_value\": %d, \"time_ns\": %u, \"time_us\": %.1f}%s\n",
               gates, e->gate_states, e->time_ns, e->time_ns / 1000.0,
               i < estimated_gcl_size - 1 ? "," : "");
    }
    printf("  ],\n");

    // Yang-style output
    printf("  \"yang_config\": {\n");
    printf("    \"ieee802-dot1q-sched:gate-parameters\": {\n");
    printf("      \"admin-gate-states\": 255,\n");
    printf("      \"admin-control-list-length\": %d,\n", estimated_gcl_size);
    printf("      \"admin-cycle-time\": {\n");
    printf("        \"numerator\": %lu,\n", estimated_cycle_ns);
    printf("        \"denominator\": 1000000000\n");
    printf("      },\n");
    printf("      \"admin-control-list\": [\n");
    for (int i = 0; i < estimated_gcl_size; i++) {
        gcl_entry_t *e = &estimated_gcl[i];
        printf("        {\n");
        printf("          \"index\": %d,\n", i);
        printf("          \"operation-name\": \"set-gate-states\",\n");
        printf("          \"sgs-params\": {\n");
        printf("            \"gate-states-value\": %d,\n", e->gate_states);
        printf("            \"time-interval-value\": %u\n", e->time_ns);
        printf("          }\n");
        printf("        }%s\n", i < estimated_gcl_size - 1 ? "," : "");
    }
    printf("      ]\n");
    printf("    }\n");
    printf("  }\n");
    printf("}\n");
}

static void print_results_human(void) {
    printf("\n");
    printf("╔════════════════════════════════════════════════════════════════╗\n");
    printf("║        TAS (Time-Aware Shaper) GCL Estimation Results          ║\n");
    printf("╚════════════════════════════════════════════════════════════════╝\n");
    printf("\n");
    printf("VLAN: %d    Estimated Cycle Time: %.3f ms (%lu ns)\n\n",
           target_vlan, estimated_cycle_ns / 1e6, estimated_cycle_ns);

    // Per-TC windows
    printf("Detected Gate Windows per TC:\n");
    printf("─────────────────────────────────────────────────────────────────\n");
    for (int t = 0; t < MAX_TC; t++) {
        tc_data_t *tc = &tc_data[t];
        if (tc->packet_count < 10) continue;

        printf("TC%d: %d packets, avg_interval=%.1f us\n", t, tc->packet_count, tc->avg_interval_us);
        for (int w = 0; w < tc->window_count; w++) {
            gate_window_t *win = &tc->windows[w];
            printf("     Window %d: start=%.1f us, duration=%.1f us\n",
                   w, win->start_offset_ns / 1000.0, win->duration_ns / 1000.0);
        }
    }

    // GCL
    printf("\n");
    printf("Estimated Gate Control List (GCL):\n");
    printf("┌───────┬──────────────┬───────────┬─────────────┐\n");
    printf("│ Index │ Gate States  │ Time (us) │  TC Open    │\n");
    printf("├───────┼──────────────┼───────────┼─────────────┤\n");

    for (int i = 0; i < estimated_gcl_size; i++) {
        gcl_entry_t *e = &estimated_gcl[i];
        char gates[9];
        char tc_list[32] = "";
        int pos = 0;

        for (int b = 7; b >= 0; b--) {
            gates[7-b] = (e->gate_states & (1 << b)) ? '1' : '0';
            if (e->gate_states & (1 << b)) {
                if (pos > 0) pos += sprintf(tc_list + pos, ",");
                pos += sprintf(tc_list + pos, "%d", b);
            }
        }
        gates[8] = '\0';
        if (pos == 0) strcpy(tc_list, "none");

        printf("│  %3d  │   %s   │ %9.1f │ %-11s │\n",
               i, gates, e->time_ns / 1000.0, tc_list);
    }
    printf("└───────┴──────────────┴───────────┴─────────────┘\n");
    printf("\n");
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "TAS GCL Estimator\n");
        fprintf(stderr, "Usage: %s <interface> <duration_sec> [vlan_id] [expected_cycle_ms]\n", argv[0]);
        fprintf(stderr, "Example: %s enxc84d44263ba6 10 100 200\n", argv[0]);
        return 1;
    }

    const char *ifname = argv[1];
    int duration = atoi(argv[2]);
    target_vlan = argc > 3 ? atoi(argv[3]) : 100;
    expected_cycle_ms = argc > 4 ? atof(argv[4]) : 0;

    memset(tc_data, 0, sizeof(tc_data));
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    char errbuf[PCAP_ERRBUF_SIZE];
    handle = pcap_open_live(ifname, 128, 1, 1, errbuf);
    if (!handle) {
        fprintf(stderr, "Error: %s\n", errbuf);
        return 1;
    }

    struct bpf_program fp;
    char filter[64];
    snprintf(filter, sizeof(filter), "vlan %d", target_vlan);
    if (pcap_compile(handle, &fp, filter, 1, PCAP_NETMASK_UNKNOWN) == 0) {
        pcap_setfilter(handle, &fp);
        pcap_freecode(&fp);
    }

    fprintf(stderr, "Capturing on %s for %d seconds (VLAN %d)...\n",
            ifname, duration, target_vlan);

    uint64_t start = get_time_ns();
    uint64_t end = start + (uint64_t)duration * 1000000000ULL;

    while (running && get_time_ns() < end) {
        pcap_dispatch(handle, 100, packet_handler, NULL);
    }

    pcap_close(handle);

    fprintf(stderr, "Analyzing for TAS patterns...\n");

    // Calculate statistics
    for (int t = 0; t < MAX_TC; t++) {
        calc_interval_stats(&tc_data[t]);
    }

    // Detect cycle time
    estimated_cycle_ns = detect_cycle_time();
    if (estimated_cycle_ns == 0) {
        fprintf(stderr, "Could not detect cycle time\n");
        return 1;
    }

    fprintf(stderr, "Detected cycle time: %.3f ms\n", estimated_cycle_ns / 1e6);

    // Build histograms and detect windows
    for (int t = 0; t < MAX_TC; t++) {
        build_histogram(&tc_data[t], estimated_cycle_ns);
        detect_windows(&tc_data[t], estimated_cycle_ns, t);
    }

    // Build GCL
    build_gcl(estimated_cycle_ns);

    // Output
    if (isatty(STDOUT_FILENO)) {
        print_results_human();
    } else {
        print_results_json();
    }

    return 0;
}
