import express from 'express';
import { interfaceDetector } from '../lib/interface-detect.js';

const router = express.Router();

/**
 * GET /api/system/interfaces
 * Returns all network interfaces with details
 */
router.get('/interfaces', async (req, res) => {
  try {
    const interfaces = await interfaceDetector.getInterfaces(req.query.refresh === 'true');
    res.json(interfaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/system/interfaces/auto
 * Auto-detect TX/RX interfaces for TSN testing
 */
router.get('/interfaces/auto', async (req, res) => {
  try {
    const result = await interfaceDetector.autoDetectTxRx();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/system/mac/:interface
 * Get MAC address of a specific interface
 */
router.get('/mac/:interface', (req, res) => {
  const mac = interfaceDetector.getMac(req.params.interface);
  if (mac && mac !== '') {
    res.json({ interface: req.params.interface, mac });
  } else {
    res.status(404).json({ error: 'Interface not found' });
  }
});

/**
 * GET /api/system/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

export default router;
