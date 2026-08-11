#!/usr/bin/env node
// Drive a ttyd web terminal over WebSocket. Handles /bin/login + BusyBox ash.
// Usage:
//   node ttyd-exec.mjs run "cmd1" "cmd2" ...
//   node ttyd-exec.mjs put /local/file /remote/path
import { readFileSync } from 'node:fs';

const WS_URL = process.env.TTYD_WS || 'wss://istore.dkapps.cn/ws';
const USER = process.env.TTYD_USER || 'root';
const PASS = process.env.TTYD_PASS || 'password';
const enc = new TextDecoder();

function send(ws, s) { ws.send(new TextEncoder().encode('0' + s)); }

const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\r/g, '');

class TTYD {
  constructor(ws) {
    this.ws = ws;
    this.allBuf = '';
    this.waiter = null;
  }

  attach() {
    this.ws.addEventListener('message', (ev) => {
      const arr = new Uint8Array(ev.data);
      if (String.fromCharCode(arr[0]) !== '0') return;
      this.allBuf += enc.decode(arr.slice(1));
      if (this.waiter && this.allBuf.includes(this.waiter.needle)) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve();
      }
    });
  }

  wait(needle, ms = 15000) {
    return new Promise((resolve, reject) => {
      if (this.allBuf.includes(needle)) { resolve(); return; }
      this.waiter = { needle, resolve };
      setTimeout(() => {
        if (this.waiter) { this.waiter = null; reject(new Error('timeout waiting for ' + needle)); }
      }, ms);
    });
  }

  async login() {
    await this.wait('login:', 10000);
    send(this.ws, USER + '\n');
    await this.wait('assword:', 10000);
    send(this.ws, PASS + '\n');
    await this.wait('~#', 10000);
    // reduce noise; harmless if PTY does not honor it
    send(this.ws, 'stty -echo 2>/dev/null\n');
    await new Promise(r => setTimeout(r, 600));
    this.allBuf = '';
  }

  async run(cmd, timeoutMs = 60000) {
    const f = '/tmp/.ttyd_o_' + Math.random().toString(36).slice(2, 8);
    const mk = 'ZZMK' + Math.random().toString(36).slice(2, 8);
    send(this.ws, `{ ${cmd}; } >${f} 2>&1; echo "RC:$?" >>${f}; printf '${mk}\\n'; cat ${f}; printf '${mk}EOF\\n'; rm -f ${f}\n`);
    await this.wait(mk + 'EOF', timeoutMs);
    // give any trailing chunk time to arrive
    await new Promise(r => setTimeout(r, 500));
    const clean = stripAnsi(this.allBuf);
    this.allBuf = '';
    const parts = clean.split(mk);
    let body = '';
    if (parts.length >= 2) {
      // parts[0] = echoed command + anything before first marker
      // parts[1] = after first marker: 'EOF\n' + cat output + 'EOF\n' + prompt...
      const inner = parts[1];
      const eofIdx = inner.indexOf('EOF\n');
      const afterMk = eofIdx >= 0 ? inner.slice(eofIdx + 4) : inner;
      const lastEof = afterMk.lastIndexOf('EOF\n');
      if (lastEof >= 0) body = afterMk.slice(0, lastEof).trim();
      else body = afterMk.trim();
      // extract RC from body tail
      const rcMatch = body.match(/RC:(\d+)\s*$/m);
      const rc = rcMatch ? rcMatch[1] : '';
      body = body.replace(/\n?RC:\d+\s*$/m, '').trim();
      if (rc && rc !== '0') process.stderr.write(`[exit ${rc}]\n`);
    } else {
      body = clean.trim();
    }
    process.stdout.write(body + '\n');
  }

  async upload(localPath, remotePath, progressLabel = '') {
    const data = readFileSync(localPath);
    const b64 = data.toString('base64');
    const CS = 3000;
    process.stderr.write(`uploading ${progressLabel || localPath} (${data.length}B) -> ${remotePath}\n`);
    send(this.ws, `> "${remotePath}.b64"\n`);
    await new Promise(r => setTimeout(r, 400));
    for (let i = 0; i < b64.length; i += CS) {
      send(this.ws, `printf '%s' '${b64.slice(i, i + CS)}' >> "${remotePath}.b64"\n`);
      await new Promise(r => setTimeout(r, 200));
      if (Math.floor(i / CS) % 20 === 0) process.stderr.write(`  ${Math.min(i + CS, b64.length)}/${b64.length}\n`);
    }
    const mk = 'ZZUP' + Math.random().toString(36).slice(2, 8);
    send(this.ws, `base64 -d "${remotePath}.b64" > "${remotePath}" && rm -f "${remotePath}.b64" && printf '${mk}OK\\n'\n`);
    await this.wait(mk + 'OK', 30000);
    this.allBuf = '';
    process.stderr.write('  upload done\n');
  }
}

async function main() {
  const [, , mode, ...args] = process.argv;
  if (!mode) { process.stderr.write('usage: ttyd-exec.mjs run "cmd" | put local remote\n'); process.exit(1); }

  const ws = new WebSocket(WS_URL, ['tty']);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('connect timeout')), 15000);
    ws.addEventListener('open', () => {
      clearTimeout(to);
      ws.send(new TextEncoder().encode(JSON.stringify({ AuthToken: '' })));
      resolve();
    });
    ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('ws error')); });
  });
  process.stderr.write('ws connected\n');

  const t = new TTYD(ws);
  t.attach();
  await t.login();
  process.stderr.write('shell ready\n');

  if (mode === 'run') {
    for (const c of args) {
      process.stderr.write(`\n>>> ${c}\n`);
      await t.run(c);
    }
  } else if (mode === 'put') {
    await t.upload(args[0], args[1], args[2]);
  }

  send(ws, 'exit\n');
  setTimeout(() => process.exit(0), 500);
}
main().catch(e => { process.stderr.write('ERROR: ' + e.message + '\n'); process.exit(1); });
