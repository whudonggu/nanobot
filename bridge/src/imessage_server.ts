/**
 * WebSocket server for nanobot <-> iMessage bridge communication.
 * Security: binds to 127.0.0.1 only; optional BRIDGE_TOKEN auth.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IMsgClient, IMsgInboundMessage } from './imessage.js';

interface AuthCommand {
  type: 'auth';
  token: string;
}

interface SendCommand {
  type: 'send';
  to: string;
  text: string;
}

type IncomingCommand = AuthCommand | SendCommand;

interface BridgeMessage {
  type: 'message' | 'status' | 'error' | 'sent';
  [key: string]: unknown;
}

export class IMessageBridgeServer {
  private wss: WebSocketServer | null = null;
  private imsg: IMsgClient | null = null;
  private clients: Set<WebSocket> = new Set();

  constructor(private port: number, private token?: string) {}

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
    console.log(`🌉 iMessage bridge listening on ws://127.0.0.1:${this.port}`);
    if (this.token) console.log('🔒 Token authentication enabled');

    this.imsg = new IMsgClient({
      onMessage: (msg) => this.onInboundMessage(msg),
      onStatus: (status) => this.broadcast({ type: 'status', status }),
      onError: (message) => this.broadcast({ type: 'error', error: message }),
      reconnectDelayMs: parseInt(process.env.IMSG_RECONNECT_DELAY_MS || '3000', 10),
      requestTimeoutMs: parseInt(process.env.IMSG_REQUEST_TIMEOUT_MS || '15000', 10),
    });

    this.wss.on('connection', (ws) => {
      if (this.token) {
        const timeout = setTimeout(() => ws.close(4001, 'Auth timeout'), 5000);
        ws.once('message', (data) => {
          clearTimeout(timeout);
          try {
            const msg = JSON.parse(data.toString()) as IncomingCommand;
            if (msg.type === 'auth' && msg.token === this.token) {
              console.log('🔗 Python client authenticated');
              this.setupClient(ws);
            } else {
              ws.close(4003, 'Invalid token');
            }
          } catch {
            ws.close(4003, 'Invalid auth message');
          }
        });
      } else {
        console.log('🔗 Python client connected');
        this.setupClient(ws);
      }
    });

    await this.imsg.connect();
  }

  private setupClient(ws: WebSocket): void {
    this.clients.add(ws);

    ws.on('message', async (data) => {
      try {
        const cmd = JSON.parse(data.toString()) as IncomingCommand;
        await this.handleCommand(ws, cmd);
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', error: String(error) }));
      }
    });

    ws.on('close', () => {
      console.log('🔌 Python client disconnected');
      this.clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.clients.delete(ws);
    });
  }

  private async handleCommand(ws: WebSocket, cmd: IncomingCommand): Promise<void> {
    if (cmd.type !== 'send') return;
    if (!this.imsg) throw new Error('iMessage client unavailable');
    await this.imsg.sendMessage(cmd.to, cmd.text);
    ws.send(JSON.stringify({ type: 'sent', to: cmd.to }));
  }

  private onInboundMessage(msg: IMsgInboundMessage): void {
    this.broadcast({ type: 'message', ...msg });
  }

  private broadcast(msg: BridgeMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.imsg) {
      await this.imsg.disconnect();
      this.imsg = null;
    }
  }
}

