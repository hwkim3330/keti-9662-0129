# TSN Verification Tools Makefile
# Compile all C-based traffic tools for stable, high-performance testing

CC = gcc
CFLAGS = -O2 -Wall -Wextra
LDFLAGS_PCAP = -lpcap -lpthread -lm
LDFLAGS_RT = -lpthread -lrt

# All binaries
BINARIES = traffic-sender traffic-capture cbs-estimator tas-estimator tsn-verify tsn-verify-simple quick-test

.PHONY: all clean install

all: $(BINARIES)
	@echo ""
	@echo "═══════════════════════════════════════════════════════════════"
	@echo "      TSN Verification Tools - Build Complete"
	@echo "═══════════════════════════════════════════════════════════════"
	@echo ""
	@echo "Available tools:"
	@echo "  traffic-sender    - High-precision VLAN-tagged packet sender"
	@echo "  traffic-capture   - Packet capture with per-TC statistics"
	@echo "  cbs-estimator     - CBS idle slope estimation from traffic"
	@echo "  tas-estimator     - TAS GCL estimation from traffic patterns"
	@echo "  tsn-verify        - Full TSN configuration verification"
	@echo "  tsn-verify-simple - Simple verification (no VLAN required)"
	@echo "  quick-test        - Quick connectivity test"
	@echo ""
	@echo "Run with: sudo ./<tool-name> --help"
	@echo ""

traffic-sender: traffic-sender.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS_RT)

traffic-capture: traffic-capture.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS_PCAP)

cbs-estimator: cbs-estimator.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS_PCAP)

tas-estimator: tas-estimator.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS_PCAP)

tsn-verify: tsn-verify.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS_PCAP) -lrt

tsn-verify-simple: tsn-verify-simple.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS_PCAP) -lrt

quick-test: quick-test.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS_PCAP)

clean:
	rm -f $(BINARIES)

install: all
	@echo "Installing to /usr/local/bin..."
	sudo cp $(BINARIES) /usr/local/bin/
	@echo "Done."
