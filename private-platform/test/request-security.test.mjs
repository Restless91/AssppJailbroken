import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constantTimeEqual,
  createRateLimiter,
  readBoundedBody,
  requireHeaderToken,
  validateCredentialConfig,
  validateMutationOrigin
} from '../request-security.mjs';

test('admin tokens are accepted only from the configured header', () => {
  assert.equal(requireHeaderToken({ headers: { 'x-admin-token': 'secret' } }, 'secret'), true);
  assert.equal(requireHeaderToken({ headers: {}, url: '/api/jobs?adminToken=secret' }, 'secret'), false);
  assert.equal(constantTimeEqual('secret', 'secret'), true);
  assert.equal(constantTimeEqual('secret', 'short'), false);
});

test('production requires an independent strong master key', () => {
  assert.throws(() => validateCredentialConfig({ production: true, masterKey: '', adminToken: 'legacy' }), /PLATFORM_MASTER_KEY/);
  assert.throws(() => validateCredentialConfig({ production: true, masterKey: 'short', adminToken: 'legacy' }), /at least 32/);
  assert.doesNotThrow(() => validateCredentialConfig({ production: true, masterKey: 'a'.repeat(32), adminToken: 'legacy' }));
  assert.doesNotThrow(() => validateCredentialConfig({ production: false, masterKey: '' }));
});

test('mutation origin accepts same-origin and rejects foreign browser origins', () => {
  assert.equal(validateMutationOrigin({ method: 'POST', headers: { host: 'router.local', origin: 'http://router.local' } }), true);
  assert.equal(validateMutationOrigin({ method: 'POST', headers: { host: 'router.local', origin: 'https://evil.example' } }), false);
  assert.equal(validateMutationOrigin({ method: 'POST', headers: { host: 'router.local' } }), true);
  assert.equal(validateMutationOrigin({ method: 'GET', headers: { host: 'router.local', origin: 'https://evil.example' } }), true);
});

test('bounded body rejects declared and streamed oversized requests', async () => {
  await assert.rejects(readBoundedBody(fakeRequest(['hello'], { 'content-length': '9' }), { maxBytes: 5 }), /too large/);
  await assert.rejects(readBoundedBody(fakeRequest(['abc', 'def']), { maxBytes: 5 }), /too large/);
  assert.equal(await readBoundedBody(fakeRequest(['abc']), { maxBytes: 5 }), 'abc');
});

test('rate limiter resets after its fixed window', () => {
  let now = 1_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 100, now: () => now });
  assert.equal(limiter.consume('client').allowed, true);
  assert.equal(limiter.consume('client').allowed, true);
  assert.equal(limiter.consume('client').allowed, false);
  now += 101;
  assert.equal(limiter.consume('client').allowed, true);
});

function fakeRequest(chunks, headers = {}) {
  return Object.assign((async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })(), { headers });
}
