import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';

// Prevent server crash on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});

import checksumRoutes from './routes/checksum.js';
import downloadRoutes from './routes/download.js';
import listRoutes from './routes/list.js';
import encodeRoutes from './routes/encode.js';
import decodeRoutes from './routes/decode.js';
import fetchRoutes from './routes/fetch.js';
import patchRoutes from './routes/patch.js';
import getRoutes from './routes/get.js';
import configRoutes from './routes/config.js';
import rpcRoutes from './routes/rpc.js';
import captureRoutes, { setWsClients, getCaptureState } from './routes/capture.js';
import trafficRoutes from './routes/traffic.js';
import ptpRoutes from './routes/ptp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for packet capture
const wss = new WebSocketServer({ server, path: '/ws/capture' });
const wsClients = new Set();

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  wsClients.add(ws);
  setWsClients(wsClients);

  // Send current capture state to newly connected client
  const state = getCaptureState();
  try {
    ws.send(JSON.stringify({
      type: 'sync',
      data: state
    }));
  } catch (e) {
    // Ignore
  }

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    wsClients.delete(ws);
    setWsClients(wsClients);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    wsClients.delete(ws);
    setWsClients(wsClients);
  });
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api/checksum', checksumRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/list', listRoutes);
app.use('/api/encode', encodeRoutes);
app.use('/api/decode', decodeRoutes);
app.use('/api/fetch', fetchRoutes);
app.use('/api/patch', patchRoutes);
app.use('/api/get', getRoutes);
app.use('/api/config', configRoutes);
app.use('/api/rpc', rpcRoutes);
app.use('/api/capture', captureRoutes);
app.use('/api/traffic', trafficRoutes);
app.use('/api/ptp', ptpRoutes);

// Health check (must be before static wildcard)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files in production (must be last)
const clientBuildPath = join(__dirname, '../client/dist');
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(join(clientBuildPath, 'index.html'));
  });
}

server.listen(PORT, () => {
  console.log(`TSN UI Server running on http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws/capture`);
});
