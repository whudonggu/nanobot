#!/usr/bin/env node
/**
 * nanobot iMessage bridge (imsg rpc).
 *
 * Required:
 * - `imsg` binary available in PATH (or set IMSG_BIN)
 *
 * Environment variables:
 * - BRIDGE_PORT (default: 3002)
 * - BRIDGE_TOKEN (optional)
 * - IMSG_BIN (default: imsg)
 * - IMSG_RPC_ARGS_JSON (default: ["rpc"])
 * - IMSG_RECONNECT_DELAY_MS (default: 3000)
 * - IMSG_REQUEST_TIMEOUT_MS (default: 15000)
 */

import { IMessageBridgeServer } from './imessage_server.js';

const PORT = parseInt(process.env.BRIDGE_PORT || '3002', 10);
const TOKEN = process.env.BRIDGE_TOKEN || undefined;

console.log('🐈 nanobot iMessage Bridge (imsg)');
console.log('================================\n');

const server = new IMessageBridgeServer(PORT, TOKEN);

process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});

server.start().catch((error) => {
  console.error('Failed to start iMessage bridge:', error);
  process.exit(1);
});

