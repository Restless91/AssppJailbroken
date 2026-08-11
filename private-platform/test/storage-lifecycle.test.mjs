import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStorageLifecycle, planStorageReconciliation } from '../storage-lifecycle.mjs';

test('router disk reservations reject overcommit and release capacity', async () => {
  const lifecycle = createStorageLifecycle({
    rootDir: '/unused',
    availableBytes: async () => 1_000
  });

  const first = await lifecycle.reserve({ artifactBytes: 300, workingCopies: 2, overheadBytes: 100 });
  assert.equal(first.requiredBytes, 700);
  await assert.rejects(
    lifecycle.reserve({ artifactBytes: 150, workingCopies: 2, overheadBytes: 100 }),
    (error) => error.code === 'insufficient_storage'
      && error.availableBytes === 1_000
      && error.reservedBytes === 700
      && error.requiredBytes === 400
  );

  first.release();
  const second = await lifecycle.reserve({ artifactBytes: 150, workingCopies: 2, overheadBytes: 100 });
  assert.equal(second.requiredBytes, 400);
  second.release();
});

test('stages privately and atomically publishes a receipt with hash and size', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'storage-lifecycle-'));
  t.after(async () => (await import('node:fs/promises')).rm(sandbox, { recursive: true, force: true }));
  const source = join(sandbox, 'source.ipa');
  const rootDir = join(sandbox, 'artifacts');
  await mkdir(rootDir);
  await writeFile(source, 'signed ipa bytes');
  const lifecycle = createStorageLifecycle({ rootDir, availableBytes: async () => 1_000_000 });

  const staged = await lifecycle.stage({ sourcePath: source, artifactId: 'job-42' });
  assert.match(staged.path, /\.staging[/\\]job-42-[a-f0-9-]+\.part$/);
  await assert.rejects(readFile(join(rootDir, 'release.ipa')), { code: 'ENOENT' });

  const receipt = await lifecycle.publish(staged, { fileName: 'release.ipa' });
  assert.deepEqual(receipt, {
    provider: 'local',
    path: join(rootDir, 'release.ipa'),
    fileName: 'release.ipa',
    size: 16,
    sha256: '82e9b37186d5a121a1589ad0089d43e87a872998fb76ca9b04e59ff979ef3de8',
    publishedAt: receipt.publishedAt
  });
  assert.equal(await readFile(receipt.path, 'utf8'), 'signed ipa bytes');
  await assert.rejects(readFile(staged.path), { code: 'ENOENT' });
});

test('discard removes an unpublished staged artifact idempotently', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'storage-lifecycle-'));
  t.after(async () => (await import('node:fs/promises')).rm(sandbox, { recursive: true, force: true }));
  const source = join(sandbox, 'source.ipa');
  await writeFile(source, 'encrypted');
  const lifecycle = createStorageLifecycle({ rootDir: join(sandbox, 'artifacts'), availableBytes: async () => 10_000 });
  const staged = await lifecycle.stage({ sourcePath: source, artifactId: 'job-1' });
  await lifecycle.discard(staged);
  await lifecycle.discard(staged);
  await assert.rejects(() => stat(staged.path), { code: 'ENOENT' });
});

test('expiration preserves the publish receipt when deletion fails and marks it retryable', async () => {
  const receipt = Object.freeze({
    provider: 'local',
    path: '/artifacts/job-42.ipa',
    fileName: 'job-42.ipa',
    size: 123,
    sha256: 'abc',
    publishedAt: '2026-08-11T00:00:00.000Z'
  });
  const lifecycle = createStorageLifecycle({
    rootDir: '/artifacts',
    availableBytes: async () => 1_000,
    deleteArtifact: async () => { throw Object.assign(new Error('disk is read-only'), { code: 'EROFS' }); }
  });

  assert.deepEqual(await lifecycle.expire(receipt), {
    status: 'delete_failed',
    retryable: true,
    receipt,
    error: { code: 'EROFS', message: 'disk is read-only' }
  });
});

test('reconciliation purely classifies missing, mismatched, and orphaned artifacts', () => {
  const expected = [
    { jobId: 'ok', provider: 'local', path: '/a.ipa', size: 10, sha256: 'aaa' },
    { jobId: 'missing', provider: 'local', path: '/b.ipa', size: 20, sha256: 'bbb' },
    { jobId: 'changed', provider: 'tencent-cos', key: 'ipa/c.ipa', size: 30, sha256: 'ccc' }
  ];
  const observed = [
    { provider: 'local', path: '/a.ipa', size: 10, sha256: 'aaa' },
    { provider: 'tencent-cos', key: 'ipa/c.ipa', size: 31, sha256: 'ccc' },
    { provider: 'local', path: '/orphan.ipa', size: 40, sha256: 'ddd' }
  ];

  assert.deepEqual(planStorageReconciliation(expected, observed), {
    healthy: [{ expected: expected[0], observed: observed[0] }],
    missing: [expected[1]],
    mismatched: [{ expected: expected[2], observed: observed[1], fields: ['size'] }],
    orphaned: [observed[2]]
  });
});
