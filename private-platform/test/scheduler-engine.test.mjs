import assert from 'node:assert/strict';
import test from 'node:test';
import { admitJob, canDispatchJob, fairQueueOrder } from '../scheduler-engine.mjs';

test('admission limits one user without blocking administrators or other users', () => {
  const jobs = [
    { status: 'queued', openid: 'noisy' },
    { status: 'running', openid: 'noisy' },
    { status: 'queued', openid: 'other' }
  ];
  assert.deepEqual(admitJob(jobs, 'noisy', { maxQueuedPerUser: 1, maxActivePerUser: 1 }), {
    admitted: false,
    code: 'user_queue_limit'
  });
  assert.equal(admitJob(jobs, 'new-user', {}).admitted, true);
  assert.equal(admitJob(jobs, null, {}).admitted, true);
});

test('fair queue order round-robins users while preserving each user FIFO', () => {
  const jobs = [
    { id: 'a1', openid: 'a', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'a2', openid: 'a', createdAt: '2026-01-01T00:00:01Z' },
    { id: 'b1', openid: 'b', createdAt: '2026-01-01T00:00:02Z' },
    { id: 'admin', openid: null, createdAt: '2026-01-01T00:00:03Z' }
  ];
  assert.deepEqual(fairQueueOrder(jobs).map((job) => job.id), ['a1', 'b1', 'admin', 'a2']);
});

test('dispatch enforces per-user active limit without blocking other users or admins', () => {
  const active = [
    { status: 'running', openid: 'busy' },
    { status: 'decrypting', openid: 'busy' },
    { status: 'uploading', openid: 'other' }
  ];
  assert.equal(canDispatchJob({ openid: 'busy' }, active, { maxActivePerUser: 2 }), false);
  assert.equal(canDispatchJob({ openid: 'other' }, active, { maxActivePerUser: 2 }), true);
  assert.equal(canDispatchJob({ openid: null }, active, { maxActivePerUser: 1 }), true);
});
