/**
 * iMessage client wrapper using `imsg rpc` (stdio JSON-RPC).
 *
 * This client subscribes to inbound message notifications and exposes
 * sendMessage for outbound delivery.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export interface IMsgInboundMessage {
  id: string;
  sender: string;
  chat_id: string;
  content: string;
  timestamp: number;
  isGroup: boolean;
  media?: string[];
}

export interface IMsgClientOptions {
  onMessage: (msg: IMsgInboundMessage) => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export class IMsgClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private cursor: string | null = null;
  private recentOutbound: Array<{ chat_id: string; content: string; ts: number }> = [];

  constructor(private options: IMsgClientOptions) {}

  async connect(): Promise<void> {
    this.running = true;
    await this.startProcessAndSubscribe();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('imsg client shutting down'));
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }

  async sendMessage(to: string, text: string): Promise<void> {
    const candidates: Array<Record<string, unknown>> = [
      { chat_id: to, text },
      { to, text },
      { chat: to, text },
      { recipient: to, text },
    ];

    let lastError: unknown = null;
    for (const params of candidates) {
      try {
        await this.request('send', params);
        this.rememberOutbound(to, text);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('send failed with all known parameter shapes');
  }

  private async startProcessAndSubscribe(): Promise<void> {
    const bin = process.env.IMSG_BIN || 'imsg';
    const args = this.getRpcArgs();

    this.options.onStatus('connecting');
    this.proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) this.options.onError(`imsg stderr: ${line}`);
    });

    this.proc.on('close', (code, signal) => {
      this.options.onStatus('disconnected');
      this.rejectAllPending(new Error(`imsg exited (code=${code}, signal=${signal})`));
      this.proc = null;
      if (this.running) this.scheduleReconnect();
    });

    this.proc.on('error', (err) => {
      this.options.onError(`failed to start imsg: ${String(err)}`);
      this.rejectAllPending(err);
      this.proc = null;
      if (this.running) this.scheduleReconnect();
    });

    try {
      await this.request('watch.subscribe', { cursor: this.cursor });
      this.options.onStatus('connected');
    } catch (err) {
      this.options.onError(`watch.subscribe failed: ${String(err)}`);
      if (this.proc) this.proc.kill('SIGTERM');
      if (this.running) this.scheduleReconnect();
    }
  }

  private getRpcArgs(): string[] {
    const json = process.env.IMSG_RPC_ARGS_JSON;
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
          return parsed;
        }
      } catch {
        // Fallback below.
      }
    }
    return ['rpc'];
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return;
    const delay = this.options.reconnectDelayMs ?? 3000;
    this.options.onStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startProcessAndSubscribe();
    }, delay);
  }

  private rejectAllPending(reason: unknown): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const idx = this.stdoutBuffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      this.handleRpcLine(line);
    }
  }

  private handleRpcLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.options.onError(`invalid JSON from imsg rpc: ${line.slice(0, 200)}`);
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        const code = typeof msg.error.code === 'number' ? ` code=${msg.error.code}` : '';
        pending.reject(new Error(`${msg.error.message || 'json-rpc error'}${code}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method === 'message') {
      const raw = this.extractRawMessage(msg.params || {});
      if (!raw) return;
      if (typeof raw.cursor === 'string') this.cursor = raw.cursor;
      const normalized = this.normalizeInbound(raw);
      if (normalized && !this.isLikelyEcho(normalized)) this.options.onMessage(normalized);
      return;
    }

    if (msg.method === 'status') {
      const state = String((msg.params || {}).state || (msg.params || {}).status || '');
      if (state) this.options.onStatus(state);
    }
  }

  private extractRawMessage(params: Record<string, unknown>): Record<string, unknown> | null {
    const nested = params.message;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const merged = { ...(nested as Record<string, unknown>) };
      if (typeof params.cursor === 'string') merged.cursor = params.cursor;
      return merged;
    }
    return params;
  }

  private normalizeInbound(raw: Record<string, unknown>): IMsgInboundMessage | null {
    const fromMeRaw = raw.from_me ?? raw.fromMe ?? raw.is_from_me ?? raw.isFromMe
      ?? raw.sender_is_self ?? raw.senderIsSelf;
    if (this.asBool(fromMeRaw)) return null;

    const sender = String(raw.sender || raw.sender_id || raw.from || '');
    const chat_id = String(raw.chat_id || raw.chat || raw.conversation_id || raw.to || sender);
    const content = String(raw.content || raw.text || '');
    const timestamp = Number(raw.timestamp || Date.now());
    const id = String(raw.id || raw.message_id || `${chat_id}:${timestamp}`);

    if (!chat_id || !id) return null;

    const media = Array.isArray(raw.media) ? raw.media.filter((m): m is string => typeof m === 'string') : [];

    return {
      id,
      sender,
      chat_id,
      content,
      timestamp,
      isGroup: Boolean(raw.is_group ?? raw.isGroup ?? false),
      ...(media.length > 0 ? { media } : {}),
    };
  }

  private asBool(v: unknown): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return ['1', 'true', 'yes', 'y'].includes(v.toLowerCase().trim());
    return false;
  }

  private rememberOutbound(chat_id: string, content: string): void {
    const now = Date.now();
    this.recentOutbound.push({ chat_id, content, ts: now });
    while (this.recentOutbound.length > 500) this.recentOutbound.shift();
    this.pruneOutbound(now);
  }

  private pruneOutbound(now: number): void {
    const ttlMs = parseInt(process.env.IMSG_ECHO_TTL_MS || '180000', 10);
    this.recentOutbound = this.recentOutbound.filter((x) => now - x.ts <= ttlMs);
  }

  private isLikelyEcho(msg: IMsgInboundMessage): boolean {
    const now = Date.now();
    this.pruneOutbound(now);
    const chat = this.norm(msg.chat_id);
    const content = (msg.content || '').trim();
    if (!chat || !content) return false;

    const idx = this.recentOutbound.findIndex(
      (x) => this.norm(x.chat_id) === chat && (x.content || '').trim() === content,
    );
    if (idx < 0) return false;
    this.recentOutbound.splice(idx, 1);
    return true;
  }

  private norm(v: string): string {
    return String(v || '').trim().toLowerCase();
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error('imsg rpc process not available'));
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    };

    const timeoutMs = this.options.requestTimeoutMs ?? 15000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`json-rpc timeout for method ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }
}
