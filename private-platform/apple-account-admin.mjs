import { randomBytes } from 'node:crypto';
import { normalizeStorefront } from './storefronts.mjs';

export function createAppleAccountAdminService({ store, request = fetch }) {
  async function authenticate({
    deviceId,
    email,
    password,
    code = '',
    deviceIdentifier = '',
    label = '',
    priority = 50,
    storefront = 'cn',
    actor = null
  }) {
    const device = requireDevice(store, deviceId);
    const stableDeviceIdentifier = String(deviceIdentifier || randomBytes(6).toString('hex')).trim();
    const response = await request(`${trimSlash(device.baseUrl)}/api/apple/authenticate`, {
      method: 'POST',
      headers: nodeHeaders(device, true),
      body: JSON.stringify({
        email: String(email || '').trim(),
        password: String(password || ''),
        code: String(code || '').trim() || undefined,
        existingCookies: [],
        deviceIdentifier: stableDeviceIdentifier
      })
    });
    const payload = await responsePayload(response);
    if (!response.ok) {
      if (payload?.codeRequired) {
        return {
          codeRequired: true,
          deviceIdentifier: stableDeviceIdentifier,
          message: payload.error || 'Authentication requires verification code'
        };
      }
      throw responseError(response.status, payload);
    }
    if (!payload?.account) throw statusError(502, 'device did not return an Apple account');
    const saved = saveGlobalAccount({
      store,
      account: payload.account,
      label,
      priority,
      storefront,
      actor
    });
    return {
      codeRequired: false,
      deviceIdentifier: stableDeviceIdentifier,
      account: saved
    };
  }

  async function syncDeviceAccount({
    deviceId,
    label = '',
    priority = 50,
    storefront = 'cn',
    actor = null
  }) {
    const device = requireDevice(store, deviceId);
    let response = await request(`${trimSlash(device.baseUrl)}/api/account/all/export`, {
      method: 'GET',
      headers: nodeHeaders(device)
    });
    let payload = await responsePayload(response);
    if (response.status === 404) {
      response = await request(`${trimSlash(device.baseUrl)}/api/account/default/export`, {
        method: 'GET',
        headers: nodeHeaders(device)
      });
      payload = await responsePayload(response);
    }
    if (!response.ok) throw responseError(response.status, payload);
    const accounts = Array.isArray(payload?.accounts)
      ? payload.accounts
      : (payload?.account ? [payload.account] : []);
    if (!accounts.length) throw statusError(502, 'device has no exportable Apple accounts');
    return accounts.map((account, index) => saveGlobalAccount({
      store,
      account,
      label: accounts.length === 1
        ? label
        : `${String(label || '设备同步账户').trim()} · ${account.email}`,
      priority,
      storefront,
      actor,
      isGlobalDefault: index === 0
    }));
  }

  return { authenticate, syncDeviceAccount };
}

function requireDevice(store, deviceId) {
  const device = store.device(String(deviceId || '').trim(), { includeSecrets: true });
  if (!device) throw statusError(404, 'device not found');
  if (!device.baseUrl) throw statusError(400, 'device base URL is not configured');
  return device;
}

function saveGlobalAccount({ store, account, label, priority, storefront, actor, isGlobalDefault = true }) {
  const email = String(account?.email || '').trim();
  if (!email) throw statusError(502, 'Apple account email is missing');
  const resolvedStorefront = normalizeStorefront(
    account?.storefront || account?.storeFront || account?.country || account?.store || storefront || 'cn'
  );
  const existing = store.listAppleAccounts({ includeSecret: true })
    .find((item) => String(item.account?.email || '').trim().toLowerCase() === email.toLowerCase());
  return store.upsertAppleAccount({
    id: existing?.id,
    label: String(label || existing?.label || email).trim(),
    priority: normalizedPriority(priority, existing?.priority),
    enabled: true,
    isGlobalDefault,
    deviceIds: [],
    storefront: resolvedStorefront,
    account: { ...account, storefront: resolvedStorefront }
  }, actor);
}

function normalizedPriority(value, fallback = 50) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.round(parsed))) : fallback;
}

function nodeHeaders(device, json = false) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (device.accessToken) headers['X-Access-Token'] = device.accessToken;
  return headers;
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function responseError(status, payload) {
  return statusError(status || 502, payload?.error || payload?.message || `device request failed (${status})`);
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}
