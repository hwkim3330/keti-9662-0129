/*
 * Quick connectivity test - send untagged packets
 * Compile: gcc -O2 -o quick-test quick-test.c -lpcap -lpthread
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <net/if.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <arpa/inet.h>
#include <pcap/pcap.h>

static volatile int running = 1;
static int rx_count = 0;
static int tx_count = 0;

static void signal_handler(int sig) {
    (void)sig;
    running = 0;
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

static void packet_handler(u_char *user, const struct pcap_pkthdr *hdr, const u_char *pkt) {
    (void)user;
    (void)hdr;
    (void)pkt;
    rx_count++;
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <tx_interface> <rx_interface> [duration]\n", argv[0]);
        return 1;
    }

    const char *tx_if = argv[1];
    const char *rx_if = argv[2];
    int duration = argc > 3 ? atoi(argv[3]) : 3;

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Get MACs
    unsigned char tx_mac[6], rx_mac[6];
    get_mac(tx_if, tx_mac);
    get_mac(rx_if, rx_mac);

    printf("TX: %s (%02x:%02x:%02x:%02x:%02x:%02x)\n", tx_if,
           tx_mac[0], tx_mac[1], tx_mac[2], tx_mac[3], tx_mac[4], tx_mac[5]);
    printf("RX: %s (%02x:%02x:%02x:%02x:%02x:%02x)\n", rx_if,
           rx_mac[0], rx_mac[1], rx_mac[2], rx_mac[3], rx_mac[4], rx_mac[5]);

    // Create TX socket
    int sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (sock < 0) {
        perror("socket");
        return 1;
    }

    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, tx_if, IFNAMSIZ - 1);
    if (ioctl(sock, SIOCGIFINDEX, &ifr) < 0) {
        perror("ioctl");
        close(sock);
        return 1;
    }

    struct sockaddr_ll sll;
    memset(&sll, 0, sizeof(sll));
    sll.sll_family = AF_PACKET;
    sll.sll_ifindex = ifr.ifr_ifindex;
    sll.sll_protocol = htons(ETH_P_ALL);
    bind(sock, (struct sockaddr *)&sll, sizeof(sll));

    // Build simple untagged ARP-like frame (EtherType 0x0806)
    unsigned char frame[64];
    memset(frame, 0, sizeof(frame));
    memcpy(frame + 0, rx_mac, 6);  // Dst = RX interface MAC
    memcpy(frame + 6, tx_mac, 6);  // Src = TX interface MAC
    frame[12] = 0x08; frame[13] = 0x06;  // EtherType: ARP
    // Rest is padding

    // Open RX capture
    char errbuf[PCAP_ERRBUF_SIZE];
    pcap_t *pcap = pcap_open_live(rx_if, 128, 1, 10, errbuf);
    if (!pcap) {
        fprintf(stderr, "pcap: %s\n", errbuf);
        close(sock);
        return 1;
    }

    // Filter for our test packets
    char filter[128];
    snprintf(filter, sizeof(filter), "ether src %02x:%02x:%02x:%02x:%02x:%02x",
             tx_mac[0], tx_mac[1], tx_mac[2], tx_mac[3], tx_mac[4], tx_mac[5]);
    struct bpf_program fp;
    if (pcap_compile(pcap, &fp, filter, 1, PCAP_NETMASK_UNKNOWN) == 0) {
        pcap_setfilter(pcap, &fp);
        pcap_freecode(&fp);
    }

    printf("Sending test packets for %d seconds...\n", duration);

    time_t start = time(NULL);
    while (running && (time(NULL) - start) < duration) {
        // Send packet
        ssize_t sent = send(sock, frame, 64, 0);
        if (sent > 0) tx_count++;

        // Check for received
        pcap_dispatch(pcap, 10, packet_handler, NULL);

        usleep(10000);  // 10ms
    }

    pcap_close(pcap);
    close(sock);

    printf("\n");
    printf("Results:\n");
    printf("  TX: %d packets\n", tx_count);
    printf("  RX: %d packets\n", rx_count);
    printf("  Loss: %.1f%%\n", tx_count > 0 ? 100.0 * (1 - (double)rx_count / tx_count) : 0);

    if (rx_count > 0) {
        printf("\n[OK] Connectivity confirmed - packets are flowing through the switch\n");
    } else {
        printf("\n[FAIL] No packets received - check cable connections and switch config\n");
    }

    return rx_count > 0 ? 0 : 1;
}
