/**
 * YANG Catalog Manager
 *
 * Automatically discovers and downloads YANG/SID files from VelocityDRIVE-SP board
 * using ietf-constrained-yang-library checksum mechanism.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { exec } from 'child_process';
import util from 'util';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execPromise = util.promisify(exec);

// SID for ietf-constrained-yang-library:yang-library/checksum
// Using specific SID for checksum query (not root SID 1)
// SID 1 queries entire device config and causes timeout on large modules (ieee802-dot1q-bridge)
const SID_CHECKSUM = 29304; // ietf-constrained-yang-library:yang-library/checksum

// Remote YANG catalog URLs (from mup1cc)
const REMOTE_CATALOGS = [
  'http://mscc-ent-open-source.s3-website-eu-west-1.amazonaws.com/public_root/velocitydrivesp/yang-by-sha',
  'https://artifacts.microchip.com/artifactory/UNGE-generic-local/lmstax/yang-by-sha'
];

// Local cache directory (project root level, not inside lib/)
const CACHE_DIR = path.join(__dirname, '../../.yang-cache');

/**
 * YANG Catalog Manager
 */
class YangCatalogManager {
  constructor() {
    this.cacheDir = CACHE_DIR;
    this.ensureCacheDir();
  }

  /**
   * Ensure cache directory exists
   */
  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Query YANG library checksum from device
   * @param {Object} serialManager - SerialManager instance
   * @returns {Promise<string>} Checksum as hex string
   */
  async queryChecksumFromDevice(serialManager) {
    if (!serialManager.getConnectionStatus()) {
      throw new Error('Not connected to device');
    }

    console.log(`Querying YANG library checksum (SID ${SID_CHECKSUM})...`);

    // Query checksum using iFETCH
    // RFC 9254: iFETCH query must be CBOR array of SIDs, not a map
    // Correct format: [29304] → 81197278 (CBOR array with integer)
    const query = [SID_CHECKSUM];
    const response = await serialManager.sendiFetchRequest(query);

    if (!response.isSuccess()) {
      throw new Error(`Failed to query checksum: CoAP code ${response.code}`);
    }

    // Decode CBOR response (will be a Map with integer keys)
    const data = response.getPayloadAsCBOR();

    // Handle both Map and Object response formats
    let checksumBytes;
    if (data instanceof Map) {
      checksumBytes = data.get(SID_CHECKSUM);
    } else if (data && typeof data === 'object') {
      checksumBytes = data[SID_CHECKSUM];
    }

    if (!checksumBytes) {
      throw new Error('Checksum not found in response');
    }

    if (!Buffer.isBuffer(checksumBytes)) {
      throw new Error('Checksum is not a byte string');
    }

    // Convert to hex string
    const checksumHex = checksumBytes.toString('hex');

    console.log(`Received checksum: ${checksumHex}`);

    return checksumHex;
  }

  /**
   * Download YANG catalog from remote servers
   * @param {string} checksum - Hex checksum
   * @returns {Promise<string>} Path to downloaded tar.gz file
   */
  async downloadCatalog(checksum) {
    const filename = `${checksum}.tar.gz`;
    const localPath = path.join(this.cacheDir, filename);

    // Check if already cached
    if (fs.existsSync(localPath)) {
      console.log(`Catalog already cached: ${localPath}`);
      return localPath;
    }

    console.log(`Downloading YANG catalog: ${checksum}...`);

    // Try each remote catalog URL
    for (const baseUrl of REMOTE_CATALOGS) {
      const url = `${baseUrl}/${filename}`;

      try {
        await this._downloadFile(url, localPath);
        console.log(`Downloaded from: ${baseUrl}`);
        return localPath;
      } catch (err) {
        console.log(`  Failed from ${baseUrl}: ${err.message}`);
        // Try next URL
      }
    }

    throw new Error(`Failed to download catalog ${checksum} from all sources`);
  }

  /**
   * Download file from URL
   * @private
   * @param {string} url - URL to download
   * @param {string} dest - Destination path
   * @returns {Promise<void>}
   */
  async _downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const file = fs.createWriteStream(dest);

      const request = protocol.get(url, (response) => {
        if (response.statusCode === 200) {
          response.pipe(file);

          file.on('finish', () => {
            file.close();
            resolve();
          });
        } else if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirect
          file.close();
          fs.unlinkSync(dest);
          this._downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
        } else {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }
      });

      request.on('error', (err) => {
        file.close();
        if (fs.existsSync(dest)) {
          fs.unlinkSync(dest);
        }
        reject(err);
      });

      file.on('error', (err) => {
        file.close();
        if (fs.existsSync(dest)) {
          fs.unlinkSync(dest);
        }
        reject(err);
      });
    });
  }

  /**
   * Extract YANG catalog tar.gz
   * @param {string} tarPath - Path to tar.gz file
   * @returns {Promise<string>} Path to extracted directory
   */
  async extractCatalog(tarPath) {
    const checksum = path.basename(tarPath, '.tar.gz');
    const extractDir = path.join(this.cacheDir, checksum);

    // Check if already extracted
    if (fs.existsSync(extractDir)) {
      console.log(`Catalog already extracted: ${extractDir}`);
      return extractDir;
    }

    console.log(`Extracting catalog...`);

    // Create extraction directory
    fs.mkdirSync(extractDir, { recursive: true });

    try {
      // Extract tar.gz
      await execPromise(`tar -xzf "${tarPath}" -C "${extractDir}"`);
      console.log(`Extracted to: ${extractDir}`);
      return extractDir;
    } catch (err) {
      throw new Error(`Failed to extract catalog: ${err.message}`);
    }
  }

  /**
   * List YANG and SID files in catalog
   * @param {string} catalogDir - Path to catalog directory
   * @returns {Object} Lists of YANG and SID files
   */
  listCatalogFiles(catalogDir) {
    const yangFiles = [];
    const sidFiles = [];

    const scan = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile()) {
          if (entry.name.endsWith('.yang')) {
            yangFiles.push(fullPath);
          } else if (entry.name.endsWith('.sid')) {
            sidFiles.push(fullPath);
          }
        }
      }
    };

    scan(catalogDir);

    return {
      yangFiles,
      sidFiles,
      count: {
        yang: yangFiles.length,
        sid: sidFiles.length
      }
    };
  }

  /**
   * Get catalog info from cache
   * @param {string} checksum - Hex checksum
   * @returns {Object|null} Catalog info or null if not cached
   */
  getCatalogInfo(checksum) {
    const catalogDir = path.join(this.cacheDir, checksum);

    if (!fs.existsSync(catalogDir)) {
      return null;
    }

    const files = this.listCatalogFiles(catalogDir);

    return {
      checksum,
      path: catalogDir,
      cached: true,
      ...files
    };
  }

  /**
   * List all cached catalogs
   * @returns {Array<Object>} List of cached catalogs
   */
  listCachedCatalogs() {
    if (!fs.existsSync(this.cacheDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.cacheDir, { withFileTypes: true });
    const catalogs = [];

    for (const entry of entries) {
      if (entry.isDirectory() && /^[0-9a-f]{32}$/i.test(entry.name)) {
        const info = this.getCatalogInfo(entry.name);
        if (info) {
          catalogs.push(info);
        }
      }
    }

    return catalogs;
  }

  /**
   * Full workflow: Query device, download, and extract catalog
   * @param {Object} serialManager - SerialManager instance
   * @returns {Promise<Object>} Catalog info
   */
  async discoverAndLoadCatalog(serialManager) {
    console.log('\n=== YANG Catalog Auto-Discovery ===\n');

    // Step 1: Query checksum from device
    const checksum = await this.queryChecksumFromDevice(serialManager);

    // Step 2: Check if already cached
    let catalogInfo = this.getCatalogInfo(checksum);
    if (catalogInfo) {
      console.log(`\nCatalog already available locally`);
      return catalogInfo;
    }

    // Step 3: Download catalog
    const tarPath = await this.downloadCatalog(checksum);

    // Step 4: Extract catalog
    const catalogDir = await this.extractCatalog(tarPath);

    // Step 5: Get catalog info
    catalogInfo = this.getCatalogInfo(checksum);

    console.log(`\nYANG catalog ready!`);
    console.log(`  Checksum: ${checksum}`);
    console.log(`  YANG files: ${catalogInfo.count.yang}`);
    console.log(`  SID files: ${catalogInfo.count.sid}`);
    console.log(`  Path: ${catalogInfo.path}\n`);

    return catalogInfo;
  }

  /**
   * Delete cached catalog
   * @param {string} checksum - Hex checksum
   */
  deleteCatalog(checksum) {
    const catalogDir = path.join(this.cacheDir, checksum);
    const tarPath = path.join(this.cacheDir, `${checksum}.tar.gz`);

    if (fs.existsSync(catalogDir)) {
      fs.rmSync(catalogDir, { recursive: true, force: true });
    }

    if (fs.existsSync(tarPath)) {
      fs.unlinkSync(tarPath);
    }
  }

  /**
   * Clear all cached catalogs
   */
  clearCache() {
    if (fs.existsSync(this.cacheDir)) {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }
}

export {
  YangCatalogManager,
  SID_CHECKSUM,
  REMOTE_CATALOGS
};
