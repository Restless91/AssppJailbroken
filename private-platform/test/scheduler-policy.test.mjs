import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDeviceCompatibility } from '../scheduler-policy.mjs';

test('a device below the app minimum iOS is rejected before assignment', () => {
  assert.deepEqual(
    evaluateDeviceCompatibility(
      { iosVersion: '14.3.0' },
      { software: { minimumOsVersion: '15.0' } }
    ),
    {
      compatible: false,
      code: 'ios_too_old',
      minimumOsVersion: '15.0',
      deviceIosVersion: '14.3.0'
    }
  );
});

test('a device with unknown iOS is not eligible for an app with a known minimum', () => {
  assert.deepEqual(
    evaluateDeviceCompatibility(
      { iosVersion: '' },
      { software: { minimumOsVersion: '15.0' } }
    ),
    {
      compatible: false,
      code: 'device_ios_unknown',
      minimumOsVersion: '15.0',
      deviceIosVersion: ''
    }
  );
});

test('a newer device is eligible for an app with a lower minimum iOS', () => {
  assert.equal(
    evaluateDeviceCompatibility(
      { iosVersion: '16.2' },
      { software: { minimumOsVersion: '15.0' } }
    ).compatible,
    true
  );
});
