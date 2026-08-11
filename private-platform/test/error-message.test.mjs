import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractErrorMessage,
  readErrorMessage
} from '../error-message.mjs';

test('Vapor error envelopes prefer the reason over boolean error flags', () => {
  assert.equal(
    readErrorMessage('{"error":true,"reason":"external IPA URL must use a private LAN host"}'),
    'external IPA URL must use a private LAN host'
  );
});

test('string error messages remain the primary error', () => {
  assert.equal(
    readErrorMessage('{"error":"authentication failed","reason":"fallback"}'),
    'authentication failed'
  );
});

test('task error extraction skips boolean flags and preserves a useful fallback', () => {
  assert.equal(
    extractErrorMessage({ error: true, reason: 'Token has no remaining uses' }),
    'Token has no remaining uses'
  );
  assert.equal(
    extractErrorMessage({ error: true }, 'iPhone 任务失败（设备未返回详细原因）'),
    'iPhone 任务失败（设备未返回详细原因）'
  );
});

test('plain text response bodies are returned unchanged', () => {
  assert.equal(readErrorMessage(' upstream timeout \n'), 'upstream timeout');
});
