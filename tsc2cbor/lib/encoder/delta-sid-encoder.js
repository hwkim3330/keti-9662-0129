/**
 * Delta-SID Encoder Module
 *
 * Implements RFC 9254 Delta-SID encoding
 * Encodes SID as delta from previous SID for compression
 */

/**
 * Encode array of SIDs to Delta-SID format
 * @param {number[]} sids - Array of SIDs in order
 * @returns {number[]} Delta-encoded SIDs
 *
 * @example
 * encodeDeltaSids([1735, 1736, 1738])
 * // Returns: [1735, 1, 2]
 * // First SID absolute, rest as deltas
 */
export function encodeDeltaSids(sids) {
  if (!Array.isArray(sids) || sids.length === 0) {
    return [];
  }

  const deltas = [sids[0]]; // First SID is absolute

  for (let i = 1; i < sids.length; i++) {
    const delta = sids[i] - sids[i - 1];
    deltas.push(delta);
  }

  return deltas;
}

/**
 * Decode Delta-SID array back to absolute SIDs
 * @param {number[]} deltas - Delta-encoded SIDs
 * @returns {number[]} Absolute SIDs
 *
 * @example
 * decodeDeltaSids([1735, 1, 2])
 * // Returns: [1735, 1736, 1738]
 */
export function decodeDeltaSids(deltas) {
  if (!Array.isArray(deltas) || deltas.length === 0) {
    return [];
  }

  const sids = [deltas[0]]; // First is absolute

  for (let i = 1; i < deltas.length; i++) {
    const sid = sids[i - 1] + deltas[i];
    sids.push(sid);
  }

  return sids;
}

/**
 * Encode object with SID keys to Delta-SID format
 * @param {Object} obj - Object with SID keys (e.g., {1735: value1, 1736: value2})
 * @returns {Map} Map with delta-SID keys
 *
 * @example
 * encodeObjectToDeltaSid({1735: "eth0", 1736: true, 1738: 1500})
 * // Returns: Map([[1735, "eth0"], [1, true], [2, 1500]])
 */
export function encodeObjectToDeltaSid(obj) {
  // Get SIDs and sort them
  const sids = Object.keys(obj).map(Number).sort((a, b) => a - b);

  // Encode to delta format
  const deltas = encodeDeltaSids(sids);

  // Build result map
  const result = new Map();
  sids.forEach((sid, index) => {
    result.set(deltas[index], obj[sid]);
  });

  return result;
}

/**
 * Decode object with Delta-SID keys to absolute SID format
 * @param {Map|Object} deltaObj - Object/Map with delta-SID keys
 * @returns {Object} Object with absolute SID keys
 *
 * @example
 * decodeObjectFromDeltaSid(Map([[1735, "eth0"], [1, true], [2, 1500]]))
 * // Returns: {1735: "eth0", 1736: true, 1738: 1500}
 */
export function decodeObjectFromDeltaSid(deltaObj) {
  // Convert to array of [delta, value] pairs
  const entries = deltaObj instanceof Map
    ? Array.from(deltaObj.entries())
    : Object.entries(deltaObj).map(([k, v]) => [Number(k), v]);

  if (entries.length === 0) {
    return {};
  }

  // Extract deltas
  const deltas = entries.map(([delta]) => delta);

  // Decode to absolute SIDs
  const sids = decodeDeltaSids(deltas);

  // Build result object
  const result = {};
  sids.forEach((sid, index) => {
    result[sid] = entries[index][1];
  });

  return result;
}

/**
 * Calculate compression ratio for Delta-SID encoding
 * @param {number[]} sids - Array of SIDs
 * @returns {object} Statistics about compression
 */
export function getDeltaSidStats(sids) {
  if (!sids || sids.length === 0) {
    return { avgDelta: 0, maxDelta: 0, minDelta: 0, compressionRatio: 1 };
  }

  const deltas = encodeDeltaSids(sids);
  const deltaValues = deltas.slice(1); // Exclude first absolute SID

  if (deltaValues.length === 0) {
    return {
      avgDelta: 0,
      maxDelta: 0,
      minDelta: 0,
      compressionRatio: 1
    };
  }

  const avgDelta = deltaValues.reduce((sum, d) => sum + d, 0) / deltaValues.length;
  const maxDelta = Math.max(...deltaValues);
  const minDelta = Math.min(...deltaValues);

  // Estimate byte size reduction
  // Small deltas (< 24) encode in 1 byte in CBOR
  // Large SIDs may need 2-4 bytes
  const avgSidBytes = sids.reduce((sum, sid) => {
    if (sid < 24) return sum + 1;
    if (sid < 256) return sum + 2;
    if (sid < 65536) return sum + 3;
    return sum + 5;
  }, 0) / sids.length;

  const avgDeltaBytes = [sids[0], ...deltaValues].reduce((sum, val) => {
    if (val < 24) return sum + 1;
    if (val < 256) return sum + 2;
    if (val < 65536) return sum + 3;
    return sum + 5;
  }, 0) / sids.length;

  const compressionRatio = avgDeltaBytes / avgSidBytes;

  return {
    avgDelta,
    maxDelta,
    minDelta,
    compressionRatio,
    avgSidBytes,
    avgDeltaBytes
  };
}
