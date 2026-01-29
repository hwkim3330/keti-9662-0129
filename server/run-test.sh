#!/bin/bash
# TSN Configuration Verification Test Script
# Usage: sudo ./run-test.sh [cbs|tas|both]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Default configuration
MODE="${1:-cbs}"
DURATION="${2:-10}"
VLAN="${3:-100}"

# Auto-detect USB NICs
USB_NICS=($(ip link show | grep -E "^[0-9]+: enx" | sed 's/.*: \(enx[^:]*\).*/\1/' | head -2))

if [ ${#USB_NICS[@]} -lt 2 ]; then
    echo "Error: Need 2 USB NICs, found ${#USB_NICS[@]}"
    echo "Available interfaces:"
    ip link show | grep -E "^[0-9]+:" | sed 's/.*: \([^:]*\).*/  \1/'
    exit 1
fi

TX_IF="${USB_NICS[0]}"
RX_IF="${USB_NICS[1]}"

echo "════════════════════════════════════════════════════════════════"
echo "              TSN Configuration Verification Test               "
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Mode:      $MODE"
echo "TX IF:     $TX_IF"
echo "RX IF:     $RX_IF"
echo "VLAN:      $VLAN"
echo "Duration:  ${DURATION}s"
echo ""

# Get MACs
TX_MAC=$(ip link show "$TX_IF" | grep ether | awk '{print $2}')
RX_MAC=$(ip link show "$RX_IF" | grep ether | awk '{print $2}')

echo "TX MAC:    $TX_MAC"
echo "RX MAC:    $RX_MAC"
echo ""

# Ensure interfaces are up
echo "Configuring interfaces..."
ip link set "$TX_IF" up 2>/dev/null || true
ip link set "$RX_IF" up 2>/dev/null || true

# Add VLAN if needed
if ! ip link show "${TX_IF}.${VLAN}" &>/dev/null; then
    ip link add link "$TX_IF" name "${TX_IF}.${VLAN}" type vlan id "$VLAN" 2>/dev/null || true
    ip link set "${TX_IF}.${VLAN}" up 2>/dev/null || true
fi
if ! ip link show "${RX_IF}.${VLAN}" &>/dev/null; then
    ip link add link "$RX_IF" name "${RX_IF}.${VLAN}" type vlan id "$VLAN" 2>/dev/null || true
    ip link set "${RX_IF}.${VLAN}" up 2>/dev/null || true
fi

echo ""
echo "Starting test..."
echo ""

# Run test
./tsn-verify \
    --mode "$MODE" \
    --tx-if "$TX_IF" \
    --rx-if "$RX_IF" \
    --vlan "$VLAN" \
    --duration "$DURATION" \
    --pps 1000 \
    --tc "0,1,2,3,4,5,6,7" \
    --dst-mac "$RX_MAC" \
    --verbose

echo ""
echo "Test complete."
