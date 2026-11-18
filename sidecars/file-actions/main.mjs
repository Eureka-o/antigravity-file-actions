import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { makeRendererSource } from './source.mjs';
import { runAction } from './actions.mjs';

const BINDING = 'agyFileActionsV1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const profile = process.env.AG_PULSE_PROFILE
  || process.env.ANTIGRAVITY_PROFILE
  || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity');

function validTarget(target, port) {
  try {
    const page = new URL(target.url);
    const socket = new URL(target.webSocketDebuggerUrl);
    return target.type === 'page'
      && ['http:', 'https:'].includes(page.protocol)
      && LOOPBACK.has(page.hostname)
      && socket.protocol === 'ws:'
      && LOOPBACK.has(socket.hostname)
      && Number(socket.port) === port;
  } catch {
    return false;
  }
}

async function discoverTargets() {
  const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid renderer port');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  const targets = await response.json();
  return { port, targets: Array.isArray(targets) ? targets.filter(target => validTarget(target, port)) : [] };
}

class CdpConnection {
  constructor(url, onEvent) {
    this.url = url;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  async open() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error('CDP command failed'));
          else pending.resolve(message.result || {});
        } else if (message.method) {
          this.onEvent(message);
        }
      } catch {}
    });
    this.socket.addEventListener('close', () => this.close());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    return this;
  }

  command(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP command timeout')); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    try { this.socket?.close(); } catch {}
  }
}

async function attach(target) {
  const connection = new CdpConnection(target.webSocketDebuggerUrl, message => {
    if (message.method !== 'Runtime.bindingCalled' || message.params?.name !== BINDING
      || typeof message.params?.payload !== 'string' || message.params.payload.length > 4096) return;
    try {
      const input = JSON.parse(message.params.payload);
      runAction(input.action, input.path);
    } catch (error) { console.error(`[file-actions] action payload failed: ${error.name}`); }
  });
  try {
    await connection.open();
    await connection.command('Page.enable');
    await connection.command('Runtime.enable');
    await connection.command('Runtime.addBinding', { name: BINDING });
    const source = makeRendererSource(BINDING);
    const script = await connection.command('Page.addScriptToEvaluateOnNewDocument', { source });
    connection.scriptId = script.identifier;
    connection.source = source;
    const result = await connection.command('Runtime.evaluate', { expression: source });
    if (result.exceptionDetails) throw new Error('Renderer script evaluation failed');
    return connection;
  } catch (error) {
    try { if (connection.scriptId) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.scriptId }); } catch {}
    connection.close();
    throw error;
  }
}

async function ensureInjected(connection) {
  const probe = await connection.command('Runtime.evaluate', {
    expression: `typeof window.__agyFileActionsDispose === 'function' && typeof window[${JSON.stringify(BINDING)}] === 'function'`,
    returnByValue: true,
  });
  if (probe.result?.value === true) return;
  await connection.command('Runtime.addBinding', { name: BINDING });
  const evalResult = await connection.command('Runtime.evaluate', { expression: connection.source });
  if (evalResult.exceptionDetails) throw new Error('Renderer recovery evaluation failed');
}

async function detach(connection) {
  try { await connection.command('Runtime.evaluate', { expression: 'window.__agyFileActionsDispose?.()' }); } catch {}
  try { await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.scriptId }); } catch {}
  try { await connection.command('Runtime.removeBinding', { name: BINDING }); } catch {}
  connection.close();
}

const sessions = new Map();
let stopping = false;
let ticking = false;
let warnedMissingPort = false;

async function tick() {
  if (stopping || ticking) return;
  ticking = true;
  try {
    const { targets } = await discoverTargets();
    warnedMissingPort = false;
    const active = new Set(targets.map(target => target.webSocketDebuggerUrl));
    for (const [url, connection] of sessions) {
      if (!active.has(url) || connection.closed) {
        await detach(connection);
        sessions.delete(url);
      }
    }
    for (const target of targets) {
      if (!sessions.has(target.webSocketDebuggerUrl)) {
        try { sessions.set(target.webSocketDebuggerUrl, await attach(target)); } catch {}
      }
    }
    for (const [url, connection] of sessions) {
      try {
        await ensureInjected(connection);
      } catch {
        await detach(connection);
        sessions.delete(url);
      }
    }
  } catch (error) {
    if (!warnedMissingPort && error?.code === 'ENOENT') {
      warnedMissingPort = true;
      console.warn('[file-actions] waiting for DevToolsActivePort (launch Antigravity with --remote-debugging-port=0 --remote-debugging-address=127.0.0.1)');
    }
  } finally {
    ticking = false;
  }
}

const timer = setInterval(() => void tick(), 3000);
void tick();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  for (const connection of sessions.values()) await detach(connection);
  sessions.clear();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
