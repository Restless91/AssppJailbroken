import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateDeviceScheduling,
  requiredDeviceFreeBytes
} from '../device-scheduling-policy.mjs';

const GIBIBYTE = 1024 * 1024 * 1024;

test('matches the iPhone download and decrypt storage budget', () => {
  assert.equal(requiredDeviceFreeBytes(500 * 1024 * 1024), 2 * GIBIBYTE);
  assert.equal(requiredDeviceFreeBytes(2 * GIBIBYTE), 6.5 * GIBIBYTE);
});

test('rejects an otherwise compatible device before assigning a large package', () => {
  assert.deepEqual(evaluateDeviceScheduling({
    iosVersion: '17.3',
    freeBytes: 2 * GIBIBYTE,
    capabilities: { externalURLDownload: true, appinstInstall: true }
  }, {
    software: { minimumOsVersion: '16.0', fileSizeBytes: String(GIBIBYTE) }
  }), {
    eligible: false,
    compatible: true,
    code: 'insufficient_storage',
    availableBytes: 2 * GIBIBYTE,
    requiredBytes: 3.5 * GIBIBYTE
  });
});

test('keeps legacy devices eligible when storage telemetry is unavailable', () => {
  assert.equal(evaluateDeviceScheduling({
    iosVersion: '14.3',
    capabilities: {}
  }, {
    software: { minimumOsVersion: '13.0', fileSizeBytes: String(GIBIBYTE) }
  }).eligible, true);
});

test('does not reject a compatible iPhone 15 when resumable batches are unavailable', () => {
  const result = evaluateDeviceScheduling({
    modelName: 'iPhone 15',
    iosVersion: '17.3.1',
    freeBytes: 90 * GIBIBYTE,
    capabilities: {
      externalURLDownload: true,
      appinstInstall: true,
      resumableBatches: false
    }
  }, {
    software: { minimumOsVersion: '15.0', fileSizeBytes: String(2 * GIBIBYTE) }
  });

  assert.equal(result.compatible, true);
  assert.equal(result.eligible, true);
});
