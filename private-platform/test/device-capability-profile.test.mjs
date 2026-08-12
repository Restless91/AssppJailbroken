import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeviceCapabilityProfile } from '../device-capability-profile.mjs';

test('profiles iPhone generations with adaptive batch and extension policy', () => {
  const jobs = [
    { software: { fileSizeBytes: '900000000' }, attempts: [{ deviceId: '11', status: 'failed', errorCode: 'memory_pressure' }] },
    { attempts: [{ deviceId: '11', status: 'completed' }] }
  ];
  const iphone15 = buildDeviceCapabilityProfile({ id: '15', modelName: 'iPhone 15', iosVersion: '17.5', providerName: 'builtin', thermalState: 'nominal' }, jobs);
  const iphone11 = buildDeviceCapabilityProfile({ id: '11', modelName: 'iPhone 11', iosVersion: '14.3', providerName: 'kernrw', jailbreakRuntime: 'Taurine/Procursus' }, jobs);
  const iphone8 = buildDeviceCapabilityProfile({ id: '8', modelName: 'iPhone 8 Plus', iosVersion: '16.2', providerName: 'builtin' }, jobs);
  assert.deepEqual({ batch: iphone15.batchSize, policy: iphone15.extensionPolicy }, { batch: 8, policy: 'compatible' });
  assert.deepEqual({ batch: iphone11.batchSize, policy: iphone11.extensionPolicy }, { batch: 2, policy: 'compatible' });
  assert.deepEqual({ batch: iphone8.batchSize, policy: iphone8.extensionPolicy }, { batch: 2, policy: 'main_only' });
});

test('thermal and vnode pressure drain a device before assignment', () => {
  const thermal = buildDeviceCapabilityProfile({ id: '15', modelName: 'iPhone 15', thermalState: 'critical' }, []);
  const vnode = buildDeviceCapabilityProfile({ id: '8', modelName: 'iPhone 8', vnodeCurrent: 950, vnodeLimit: 1000 }, []);
  assert.equal(thermal.eligible, false);
  assert.equal(thermal.reason, 'thermal_pressure');
  assert.equal(vnode.eligible, false);
  assert.equal(vnode.reason, 'vnode_pressure');
});

test('large packages prefer newer devices and strict policy is a hard capability requirement', () => {
  const job = { software: { fileSizeBytes: String(900 * 1024 * 1024) }, extensionDecryptionPolicy: 'strict' };
  const capable = buildDeviceCapabilityProfile({ id: '15', modelName: 'iPhone 15', capabilities: { extensionDecryption: true } }, [], job);
  const incapable = buildDeviceCapabilityProfile({ id: '8', modelName: 'iPhone 8', capabilities: { extensionDecryption: false } }, [], job);
  assert.ok(capable.score > 0);
  assert.equal(incapable.eligible, false);
  assert.equal(incapable.reason, 'extension_decryption_unavailable');
});
