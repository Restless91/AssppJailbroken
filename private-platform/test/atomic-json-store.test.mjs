import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeAtomicJson } from '../atomic-json-store.mjs';

test('concurrent state snapshots never share or strand temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-json-'));
  const path = join(directory, 'state.json');
  try {
    await Promise.all(Array.from({ length: 100 }, (_, revision) =>
      writeAtomicJson(path, { revision, payload: 'x'.repeat(4096) })
    ));
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(typeof snapshot.revision, 'number');
    assert.equal(snapshot.payload.length, 4096);
    assert.deepEqual(await readdir(directory), ['state.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
