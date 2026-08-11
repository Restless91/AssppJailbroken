import assert from 'node:assert/strict';
import test from 'node:test';
import { createOnlineDevicePool } from '../device-pool.mjs';

function devices() {
  return [
    { id: 'offline', name: 'Offline', online: false },
    { id: 'a', name: 'A', online: true },
    { id: 'b', name: 'B', online: true }
  ];
}

test('automatic device calls only use online devices and rotate fairly', async () => {
  const pool = createOnlineDevicePool({ listDevices: devices });
  const selected = [];

  for (let index = 0; index < 5; index += 1) {
    selected.push(await pool.run((device) => device.id));
  }

  assert.deepEqual(selected, ['a', 'b', 'a', 'b', 'a']);
});

test('automatic calls fail over to another online device after a connection failure', async () => {
  const markedOffline = [];
  const pool = createOnlineDevicePool({
    listDevices: devices,
    markOffline: async (device) => markedOffline.push(device.id),
    isUnavailable: (error) => error.deviceUnavailable === true
  });

  const calls = [];
  const result = await pool.run(async (device) => {
    calls.push(device.id);
    if (device.id === 'a') {
      const error = new Error('connection refused');
      error.deviceUnavailable = true;
      throw error;
    }
    return device.id;
  });

  assert.equal(result, 'b');
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(markedOffline, ['a']);
});

test('business errors do not retry on another device', async () => {
  const pool = createOnlineDevicePool({
    listDevices: devices,
    isUnavailable: (error) => error.deviceUnavailable === true
  });
  const calls = [];

  await assert.rejects(
    pool.run(async (device) => {
      calls.push(device.id);
      throw new Error('Apple account is invalid');
    }),
    /Apple account is invalid/
  );
  assert.deepEqual(calls, ['a']);
});

test('an explicitly selected device stays strict and is never silently replaced', async () => {
  const pool = createOnlineDevicePool({
    listDevices: devices,
    isUnavailable: (error) => error.deviceUnavailable === true
  });
  const calls = [];

  await assert.rejects(
    pool.run(async (device) => {
      calls.push(device.id);
      const error = new Error('connection refused');
      error.deviceUnavailable = true;
      throw error;
    }, { deviceId: 'a' }),
    /connection refused/
  );
  assert.deepEqual(calls, ['a']);
});

test('automatic calls return a clear service-unavailable error when no device is online', async () => {
  const pool = createOnlineDevicePool({
    listDevices: () => devices().map((device) => ({ ...device, online: false }))
  });

  await assert.rejects(
    pool.run((device) => device.id),
    (error) => error.status === 503 && /暂无在线设备/.test(error.message)
  );
  assert.equal(pool.optional(), null);
});
