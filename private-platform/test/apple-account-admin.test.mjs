import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppleAccountAdminService } from '../apple-account-admin.mjs';

function fixture(responses) {
  const saved = [];
  const existing = [];
  const store = {
    device(id) {
      return id === 'iphone-11'
        ? { id, name: 'iPhone 11', baseUrl: 'http://iphone.test', accessToken: 'node-admin' }
        : null;
    },
    listAppleAccounts() {
      return existing;
    },
    upsertAppleAccount(input) {
      saved.push(input);
      const value = { id: input.id || `account-${saved.length}`, ...input, account: null };
      const index = existing.findIndex((item) => item.id === value.id);
      if (index >= 0) existing[index] = { ...value, account: input.account };
      else existing.push({ ...value, account: input.account });
      return value;
    }
  };
  const requests = [];
  const request = async (url, options = {}) => {
    requests.push({ url, options });
    return responses.shift();
  };
  return { store, saved, requests, service: createAppleAccountAdminService({ store, request }) };
}

test('syncing a device account stores one global account available to every device', async () => {
  const account = {
    email: 'owner@example.com',
    password: 'secret',
    passwordToken: 'token',
    cookies: [],
    deviceIdentifier: 'abcdef123456'
  };
  const value = fixture([
    new Response(JSON.stringify({ account }), { status: 200 }),
    new Response(JSON.stringify({ account: { ...account, passwordToken: 'refreshed' } }), { status: 200 })
  ]);

  const firstSync = await value.service.syncDeviceAccount({ deviceId: 'iphone-11', label: '主账户' });
  const secondSync = await value.service.syncDeviceAccount({ deviceId: 'iphone-11', label: '主账户' });

  assert.equal(firstSync.length, 1);
  assert.equal(secondSync.length, 1);
  assert.equal(value.saved.length, 2);
  assert.equal(value.saved[0].isGlobalDefault, true);
  assert.deepEqual(value.saved[0].deviceIds, []);
  assert.equal(value.saved[1].id, value.saved[0].id);
  assert.equal(value.saved[1].account.passwordToken, 'refreshed');
  assert.equal(value.requests[0].options.headers['X-Access-Token'], 'node-admin');
});

test('syncing device accounts imports every account returned by the device', async () => {
  const first = {
    email: 'first@example.com',
    password: 'secret-1',
    passwordToken: 'token-1',
    cookies: [],
    deviceIdentifier: 'device-first'
  };
  const second = {
    email: 'second@example.com',
    password: 'secret-2',
    passwordToken: 'token-2',
    cookies: [],
    deviceIdentifier: 'device-second'
  };
  const value = fixture([
    new Response(JSON.stringify({ accounts: [first, second] }), { status: 200 })
  ]);

  const accounts = await value.service.syncDeviceAccount({
    deviceId: 'iphone-11',
    label: '设备同步账户'
  });

  assert.equal(accounts.length, 2);
  assert.equal(value.saved.length, 2);
  assert.deepEqual(value.saved.map((item) => item.account.email), [
    'first@example.com',
    'second@example.com'
  ]);
  assert.match(value.requests[0].url, /\/api\/account\/all\/export$/);
});

test('authentication preserves the device identifier while waiting for a verification code', async () => {
  const value = fixture([
    new Response(JSON.stringify({
      error: 'Authentication requires verification code',
      codeRequired: true
    }), { status: 401 })
  ]);

  const result = await value.service.authenticate({
    deviceId: 'iphone-11',
    email: 'owner@example.com',
    password: 'secret',
    deviceIdentifier: 'fixed-device'
  });

  assert.equal(result.codeRequired, true);
  assert.equal(result.deviceIdentifier, 'fixed-device');
  assert.equal(value.saved.length, 0);
});

test('successful authentication saves a global reusable account', async () => {
  const account = {
    email: 'owner@example.com',
    password: 'secret',
    passwordToken: 'token',
    cookies: [],
    deviceIdentifier: 'fixed-device'
  };
  const value = fixture([
    new Response(JSON.stringify({ account }), { status: 200 })
  ]);

  const result = await value.service.authenticate({
    deviceId: 'iphone-11',
    email: account.email,
    password: account.password,
    code: '123456',
    deviceIdentifier: account.deviceIdentifier,
    label: '主账户'
  });

  assert.equal(result.codeRequired, false);
  assert.equal(value.saved[0].isGlobalDefault, true);
  assert.deepEqual(value.saved[0].deviceIds, []);
  assert.equal(value.saved[0].account.email, account.email);
  assert.match(value.requests[0].url, /\/api\/apple\/authenticate$/);
});
