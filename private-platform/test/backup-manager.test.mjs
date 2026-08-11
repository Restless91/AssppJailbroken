import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBackupManager } from '../backup-manager.mjs';

test('creates a consistent WAL database snapshot and verifies it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asspp-backup-'));
  const path = join(root, 'platform.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE jobs(id TEXT PRIMARY KEY, value TEXT);');
  db.prepare('INSERT INTO jobs VALUES (?, ?)').run('one', 'saved');
  const manager = createBackupManager({ database: db, databasePath: path, backupRoot: join(root, 'backups') });
  const backup = await manager.create({ label: 'test' });
  assert.equal((await manager.verify(backup.directory)).schemaVersion, 1);
  const snapshot = new DatabaseSync(join(backup.directory, 'platform.sqlite'), { readOnly: true });
  assert.equal(snapshot.prepare('SELECT value FROM jobs WHERE id = ?').get('one').value, 'saved');
  snapshot.close();
  db.close();
});

test('rejects a modified backup before restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asspp-backup-'));
  const path = join(root, 'platform.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE jobs(id TEXT);');
  const manager = createBackupManager({ database: db, databasePath: path, backupRoot: join(root, 'backups') });
  const backup = await manager.create();
  const snapshotPath = join(backup.directory, 'platform.sqlite');
  await writeFile(snapshotPath, Buffer.concat([await readFile(snapshotPath), Buffer.from('tampered')]));
  await assert.rejects(() => manager.verify(backup.directory), { code: 'backup_checksum_mismatch' });
  db.close();
});
