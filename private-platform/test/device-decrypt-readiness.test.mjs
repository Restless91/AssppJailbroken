import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDeviceDecryptReadiness } from '../device-decrypt-readiness.mjs';

test('rejects a device that cannot install the downloaded IPA', () => {
  assert.deepEqual(evaluateDeviceDecryptReadiness({
    capabilities: {
      externalURLDownload: true,
      appinstInstall: false,
      trollStoreInstall: false
    }
  }), {
    ready: false,
    code: 'ipa_install_provider_unavailable'
  });
});

test('accepts appinst and TrollStore installation providers', () => {
  assert.equal(evaluateDeviceDecryptReadiness({
    capabilities: { externalURLDownload: true, appinstInstall: true, trollStoreInstall: false }
  }).ready, true);
  assert.equal(evaluateDeviceDecryptReadiness({
    capabilities: { externalURLDownload: true, appinstInstall: false, trollStoreInstall: true }
  }).ready, true);
});

test('keeps old nodes without capability discovery backward compatible', () => {
  assert.equal(evaluateDeviceDecryptReadiness({ capabilities: {} }).ready, true);
});

test('enforces explicitly reported resumable and strict policy capabilities', () => {
  const capabilities = {
    externalURLDownload: true, appinstInstall: true, trollStoreInstall: false,
    resumableBatches: false, extensionPolicies: ['main_only', 'compatible']
  };
  assert.equal(evaluateDeviceDecryptReadiness({ capabilities }, { resumableBatches: true }).code, 'resumable_batches_unavailable');
  assert.equal(evaluateDeviceDecryptReadiness({ capabilities }, { extensionPolicy: 'strict' }).code, 'strict_extension_policy_unavailable');
});
