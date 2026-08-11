import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

export async function syncBrowserAccount({ device, existingAccount = {} }) {
  const dbDir = device.browserAccountDbPath || defaultEdgeIndexedDbPath(device.baseUrl);
  const parsed = await readAssppAccountFromLevelDb(dbDir);
  const account = mergeAccount(existingAccount, parsed);
  account.updatedAt = new Date().toISOString();
  account.syncedFrom = 'edge-indexeddb';
  return { account, source: dbDir };
}

function defaultEdgeIndexedDbPath(baseUrl) {
  const url = new URL(baseUrl);
  return join(
    homedir(),
    'Library/Application Support/Microsoft Edge/Default/IndexedDB',
    `http_${url.hostname}_${url.port || '80'}.indexeddb.leveldb`
  );
}

async function readAssppAccountFromLevelDb(dbDir) {
  const names = await readdir(dbDir);
  const files = names.filter((name) => /\.(ldb|log)$/.test(name)).sort();
  if (!files.length) throw new Error(`未找到浏览器账号数据库文件：${dbDir}`);
  const buffers = await Promise.all(files.map((name) => readFile(join(dbDir, name))));
  const data = Buffer.concat(buffers);

  const email = findEmail(data);
  const cookies = findCookies(data);
  if (!email && !cookies.length) {
    throw new Error('浏览器缓存里没有解析到 Asspp 账号，请先在 iPhone 原网页账号页登录一次。');
  }

  return {
    email,
    appleId: extractStringAfterKey(data, 'appleId') || email,
    password: extractStringAfterKey(data, 'password'),
    passwordToken: extractStringAfterKey(data, 'passwordToken'),
    directoryServicesIdentifier: extractStringAfterKey(data, 'directoryServicesIdentifier'),
    deviceIdentifier: extractStringAfterKey(data, 'deviceIdentifier'),
    store: extractStringAfterKey(data, 'store'),
    pod: extractStringAfterKey(data, 'pod'),
    firstName: extractStringAfterKey(data, 'firstName'),
    lastName: extractStringAfterKey(data, 'lastName'),
    cookies
  };
}

function mergeAccount(existing, parsed) {
  const merged = { ...existing };
  setIf(merged, parsed, 'email', (value) => /@/.test(value));
  setIf(merged, parsed, 'appleId', (value) => /@/.test(value) || /^\d+$/.test(value));
  setIf(merged, parsed, 'password', (value) => value.length >= 4);
  setIf(merged, parsed, 'passwordToken', (value) => value.length >= 8);
  setIf(merged, parsed, 'directoryServicesIdentifier', (value) => /^\d+$/.test(value));
  setIf(merged, parsed, 'deviceIdentifier', (value) => /^[a-z0-9-]{6,}$/i.test(value));
  setIf(merged, parsed, 'store', (value) => /^\d+(?:-\d+)?$/.test(value));
  setIf(merged, parsed, 'pod', (value) => /^\d+$/.test(value));
  setIf(merged, parsed, 'firstName', (value) => value.length > 0 && value.length < 100);
  setIf(merged, parsed, 'lastName', (value) => value.length > 0 && value.length < 100);
  if (Array.isArray(parsed.cookies) && parsed.cookies.length) merged.cookies = parsed.cookies;
  return merged;
}

function setIf(target, source, key, predicate) {
  const value = String(source[key] ?? '');
  if (value && predicate(value)) target[key] = value;
}

function findEmail(data) {
  return data.toString('latin1').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
}

function findCookies(data) {
  const key = Buffer.from('cookies');
  let index = 0;
  while ((index = data.indexOf(key, index)) >= 0) {
    for (let pos = index + key.length; pos < Math.min(data.length, index + key.length + 120); pos += 1) {
      if (data[pos] !== 0x41) continue;
      try {
        const value = parseStructuredCloneValue(data, pos);
        if (Array.isArray(value) && value.length && value[0]?.name && value[0]?.value) {
          return value.map(normalizeCookie);
        }
      } catch {}
    }
    index += key.length;
  }
  return [];
}

function normalizeCookie(cookie) {
  return {
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    path: String(cookie.path || '/'),
    domain: cookie.domain ? String(cookie.domain) : undefined,
    expiresAt: typeof cookie.expiresAt === 'number' ? cookie.expiresAt : undefined,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure)
  };
}

function extractStringAfterKey(data, key) {
  const needle = Buffer.from(key);
  const index = data.indexOf(needle);
  if (index < 0) return '';
  for (let pos = index + needle.length; pos < Math.min(data.length, index + needle.length + 320); pos += 1) {
    const tag = data[pos];
    try {
      if (tag === 0x22) {
        const [length, start] = readVarint(data, pos + 1);
        if (length > 0 && length < 1000) return data.slice(start, start + length).toString('utf8');
      }
      if (tag === 0x63) {
        const [length, start] = readVarint(data, pos + 1);
        if (length > 0 && length < 1000) return data.slice(start, start + length * 2).toString('utf16le');
      }
    } catch {}
  }
  return '';
}

function parseStructuredCloneValue(data, start) {
  let pos = start;

  function readValue() {
    const tag = data[pos++];
    if (tag === 0x22) {
      const [length, next] = readVarint(data, pos);
      pos = next;
      const value = data.slice(pos, pos + length).toString('utf8');
      pos += length;
      return value;
    }
    if (tag === 0x63) {
      const [length, next] = readVarint(data, pos);
      pos = next;
      const value = data.slice(pos, pos + length * 2).toString('utf16le');
      pos += length * 2;
      return value;
    }
    if (tag === 0x54) return true;
    if (tag === 0x46) return false;
    if (tag === 0x30) return null;
    if (tag === 0x5f) return undefined;
    if (tag === 0x4e) {
      const value = data.readDoubleLE(pos);
      pos += 8;
      return value;
    }
    if (tag === 0x49 || tag === 0x55) {
      const [value, next] = readVarint(data, pos);
      pos = next;
      return value;
    }
    if (tag === 0x6f) {
      const object = {};
      while (pos < data.length && data[pos] !== 0x7b) {
        const key = readValue();
        const value = readValue();
        if (typeof key === 'string') object[key] = value;
      }
      if (data[pos] === 0x7b) {
        pos += 1;
        const [, next] = readVarint(data, pos);
        pos = next;
      }
      return object;
    }
    if (tag === 0x41) {
      const [length, next] = readVarint(data, pos);
      pos = next;
      const array = [];
      for (let index = 0; index < length; index += 1) array.push(readValue());
      if (data[pos] === 0x24 || data[pos] === 0x40) {
        pos += 1;
        const [propCount, propNext] = readVarint(data, pos);
        pos = propNext;
        for (let index = 0; index < propCount; index += 1) {
          const key = readValue();
          const value = readValue();
          array[key] = value;
        }
      }
      return array;
    }
    if (tag === 0x5e) {
      const [, next] = readVarint(data, pos);
      pos = next;
      return undefined;
    }
    throw new Error(`unsupported structured clone tag 0x${tag.toString(16)}`);
  }

  return readValue();
}

function readVarint(data, start) {
  let value = 0;
  let shift = 0;
  let pos = start;
  while (pos < data.length) {
    const byte = data[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, pos];
    shift += 7;
  }
  throw new Error('unexpected varint eof');
}
