import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthModel, createMetricsRegistry } from '../observability.mjs';

test('readiness reports each dependency and becomes unavailable when one fails', async () => {
  const health = createHealthModel({
    database: async () => ({ ok: true }),
    storage: async () => ({ ok: false, reason: 'low_space' }),
    devicePool: async () => ({ ok: true, online: 3 })
  });

  assert.deepEqual(await health.live(), { ok: true, status: 'live' });
  assert.deepEqual(await health.ready(), {
    ok: false,
    status: 'not_ready',
    checks: {
      database: { ok: true },
      storage: { ok: false, reason: 'low_space' },
      devicePool: { ok: true, online: 3 }
    }
  });
});

test('metrics registry emits prometheus text and rejects unbounded label names', () => {
  const metrics = createMetricsRegistry({ allowedLabels: ['stage', 'result'] });
  metrics.increment('platform_jobs_total', { stage: 'decrypt', result: 'success' });
  metrics.increment('platform_jobs_total', { stage: 'decrypt', result: 'success' }, 2);
  metrics.gauge('platform_queue_depth', 4);

  assert.match(metrics.render(), /platform_jobs_total\{result="success",stage="decrypt"\} 3/);
  assert.match(metrics.render(), /platform_queue_depth 4/);
  assert.throws(() => metrics.increment('bad_metric', { jobId: 'unbounded' }), /label is not allowed/);
});
