import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function gatewayBodyHash(body = '') {
  return createHash('sha256').update(toBuffer(body)).digest('hex');
}

export function gatewayCanonicalRequest({ method, path, timestamp, nonce, body = '' }) {
  return [
    String(method || 'GET').toUpperCase(),
    String(path || '/'),
    String(timestamp),
    String(nonce),
    gatewayBodyHash(body)
  ].join('\n');
}

export function signGatewayRequest(secret, request) {
  return createHmac('sha256', String(secret || ''))
    .update(gatewayCanonicalRequest(request))
    .digest('hex');
}

export function verifyGatewaySignature(secret, signature, request) {
  const expected = Buffer.from(signGatewayRequest(secret, request), 'hex');
  const received = Buffer.from(String(signature || ''), 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export class WechatGatewayClient {
  constructor(config = {}, fetchImpl = globalThis.fetch) {
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    this.clientId = String(config.clientId || '');
    this.clientSecret = String(config.clientSecret || '');
    this.appId = String(config.appId || '');
    this.timeoutMs = Math.max(1000, Number(config.timeoutMs || 10_000));
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.baseUrl && this.clientId && this.clientSecret && this.appId);
  }

  async request(path, { method = 'GET', body, query } = {}) {
    if (!this.configured) throw gatewayError(503, '微信公众号网关未配置');
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const canonical = { method, path: url.pathname, timestamp, nonce, body: payload };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          'X-Client-Id': this.clientId,
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          'X-Signature': signGatewayRequest(this.clientSecret, canonical)
        },
        ...(payload ? { body: payload } : {})
      });
      const text = await response.text();
      let value = {};
      try {
        value = text ? JSON.parse(text) : {};
      } catch {
        value = { error: text };
      }
      if (!response.ok) {
        throw gatewayError(response.status, value.error || value.message || `微信公众号网关请求失败（${response.status}）`);
      }
      return value.data ?? value;
    } finally {
      clearTimeout(timer);
    }
  }

  createLoginSession(browserNonce, expiresInSeconds = 300) {
    return this.request('/internal/v1/login-sessions', {
      method: 'POST',
      body: { appid: this.appId, browserNonce, expiresInSeconds }
    });
  }

  loginStatus(sessionId) {
    return this.request(`/internal/v1/login-sessions/${encodeURIComponent(sessionId)}`);
  }

  sendMessage(input) {
    return this.request('/internal/v1/messages', {
      method: 'POST',
      body: { appid: this.appId, ...input }
    });
  }
}

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''));
}

function gatewayError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
