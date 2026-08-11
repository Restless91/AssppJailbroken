import { createHash, createHmac } from 'node:crypto';

export function encodeCosPath(key) {
  return String(key).split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function cosAuthorization({
  secretId,
  secretKey,
  method,
  pathname,
  headers,
  lifetimeSeconds = 7200,
  nowSeconds = Math.floor(Date.now() / 1000)
}) {
  const keyTime = `${nowSeconds};${nowSeconds + lifetimeSeconds}`;
  const headerEntries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value).trim()])
    .sort(([a], [b]) => a.localeCompare(b));
  const headerList = headerEntries.map(([key]) => key).join(';');
  const httpHeaders = headerEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const httpString = [
    method.toLowerCase(),
    pathname,
    '',
    httpHeaders,
    ''
  ].join('\n');
  const stringToSign = [
    'sha1',
    keyTime,
    sha1(httpString),
    ''
  ].join('\n');
  const signKey = hmacSha1Hex(secretKey, keyTime);
  const signature = hmacSha1Hex(signKey, stringToSign);
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    'q-url-param-list=',
    `q-signature=${signature}`
  ].join('&');
}

export function cosSignedDownloadUrl(cos, key, {
  nowSeconds = Math.floor(Date.now() / 1000)
} = {}) {
  const defaultHost = `${cos.bucket}.cos.${cos.region}.myqcloud.com`;
  const publicBase = parsePublicBase(cos.publicDomain, defaultHost);
  const pathname = `/${key}`;
  const authorization = cosAuthorization({
    secretId: cos.secretId,
    secretKey: cos.secretKey,
    method: 'GET',
    pathname,
    headers: { host: publicBase.host },
    lifetimeSeconds: Math.max(60, Number(cos.signedUrlMinutes || 15) * 60),
    nowSeconds
  });
  return `${publicBase.baseUrl}/${encodeCosPath(key)}?${authorization}`;
}

function parsePublicBase(value, defaultHost) {
  const raw = String(value || '').trim();
  const parsed = new URL(raw || `https://${defaultHost}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('COS 自定义访问域名必须使用 http:// 或 https://');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('COS 自定义访问域名不能包含查询参数或锚点');
  }
  const path = parsed.pathname.replace(/\/+$/g, '');
  return {
    host: parsed.host,
    baseUrl: `${parsed.origin}${path}`
  };
}

function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex');
}

function hmacSha1Hex(key, value) {
  return createHmac('sha1', key).update(String(value)).digest('hex');
}
