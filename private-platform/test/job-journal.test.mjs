import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { JobJournal } from '../job-journal.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'asspp-job-journal-'));
  const database = new DatabaseSync(join(directory, 'platform.sqlite'));
  const journal = new JobJournal(database);
  return { journal, database, cleanup: () => { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('job snapshots survive journal recreation and reject stale revisions', () => {
  const value = fixture();
  try {
    value.journal.save({ id: 'job-1', status: 'queued', updatedAt: '2026-08-11T00:00:00Z' });
    const revision = value.journal.get('job-1').journalRevision;
    value.journal.save({ id: 'job-1', status: 'running', updatedAt: '2026-08-11T00:01:00Z' }, revision);
    assert.throws(
      () => value.journal.save({ id: 'job-1', status: 'failed' }, revision),
      /stale job revision/
    );
    assert.equal(new JobJournal(value.database).get('job-1').status, 'running');
  } finally { value.cleanup(); }
});

test('device leases are persistent, exclusive and idempotent for the owning job', () => {
  const value = fixture();
  try {
    assert.equal(value.journal.acquireDeviceLease('iphone-15', 'job-1'), true);
    assert.equal(value.journal.acquireDeviceLease('iphone-15', 'job-1'), true);
    assert.equal(new JobJournal(value.database).acquireDeviceLease('iphone-15', 'job-2'), false);
    value.journal.releaseDeviceLease('iphone-15', 'job-1');
    assert.equal(value.journal.acquireDeviceLease('iphone-15', 'job-2'), true);
  } finally { value.cleanup(); }
});

test('legacy import is idempotent and never replaces a newer database job', () => {
  const value = fixture();
  try {
    value.journal.importLegacy([{ id: 'job-1', status: 'completed' }]);
    value.journal.importLegacy([{ id: 'job-1', status: 'queued' }, { id: 'job-2', status: 'failed' }]);
    assert.deepEqual(value.journal.list().map((job) => [job.id, job.status]), [
      ['job-1', 'completed'],
      ['job-2', 'failed']
    ]);
  } finally { value.cleanup(); }
});
