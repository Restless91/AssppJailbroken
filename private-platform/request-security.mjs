import { timingSafeEqual } from 'node:crypto';

export function constantTimeEqual(actual, expected) {
  const left = Buffer.from(String(actual ?? ''));
  const right = Buffer.from(String(expected ?? ''));
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function requireHeaderToken(req, expected) {
  if (!expected) return true;
  return constantTimeEqual(req?.headers?.['x-admin-token'], expected);
}

export function validateCredentialConfig({ production, masterKey }) {
  if (!production) return true;
  if (!masterKey) throw new Error('PLATFORM_MASTER_KEY is required in production');
  if (String(masterKey).length < 32) throw new Error('PLATFORM_MASTER_KEY must contain at least 32 characters');
  return true;
}

export function validateMutationOrigin(req, { allowedOrigins = [] } = {}) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req?.method || '').toUpperCase())) return true;
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return true;
  const allowed = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean));
  const host = String(req?.headers?.host || '').trim();
  if (host) {
    allowed.add(normalizeOrigin(`http://${host}`));
    allowed.add(normalizeOrigin(`https://${host}`));
  }
  return allowed.has(normalizeOrigin(origin));
}

export async function readBoundedBody(req, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const declared = Number(req?.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw requestError(413, 'request body is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw requestError(413, 'request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = 10_000 }) {
  const entries = new Map();
  return {
    consume(key) {
      const timestamp = now();
      const normalized = String(key || 'unknown');
      let entry = entries.get(normalized);
      if (!entry || timestamp >= entry.resetAt) entry = { count: 0, resetAt: timestamp + windowMs };
      entry.count += 1;
      entries.set(normalized, entry);
      if (entries.size > maxKeys) prune(entries, timestamp, maxKeys);
      return {
        allowed: entry.count <= limit,
        remaining: Math.max(0, limit - entry.count),
        retryAfterMs: Math.max(0, entry.resetAt - timestamp)
      };
    }
  };
}

function normalizeOrigin(value) {
  try { return new URL(value).origin; } catch { return ''; }
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

function prune(entries, timestamp, maxKeys) {
  for (const [key, entry] of entries) {
    if (entry.resetAt <= timestamp || entries.size > maxKeys) entries.delete(key);
    if (entries.size <= maxKeys) break;
  }
}
