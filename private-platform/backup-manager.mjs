import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

export function createBackupManager({ database, databasePath, backupRoot, now = () => new Date() }) {
  if (!database || !databasePath || !backupRoot) throw new TypeError('database, databasePath and backupRoot are required');
  const sourcePath = resolve(databasePath);
  const root = resolve(backupRoot);

  return {
    async create({ label = 'scheduled' } = {}) {
      const timestamp = now().toISOString().replace(/[:.]/g, '-');
      const safeLabel = safeSegment(label);
      const directory = join(root, `${timestamp}-${safeLabel}`);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(directory, { recursive: false, mode: 0o700 });
      const snapshotPath = join(directory, 'platform.sqlite');
      database.exec('PRAGMA wal_checkpoint(FULL)');
      database.exec(`VACUUM INTO '${sqliteQuote(snapshotPath)}'`);
      const metadata = await stat(snapshotPath);
      const manifest = {
        schemaVersion: 1,
        createdAt: now().toISOString(),
        source: basename(sourcePath),
        database: { file: 'platform.sqlite', size: metadata.size, sha256: await sha256File(snapshotPath) }
      };
      await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await verifyBackup(directory);
      return { directory, manifest };
    },
    verify: verifyBackup,
    async restore({ backupDirectory, targetPath = sourcePath }) {
      const verified = await verifyBackup(backupDirectory);
      const target = resolve(targetPath);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.restore-${process.pid}`;
      await copyFile(join(resolve(backupDirectory), verified.database.file), temporary);
      try {
        const restored = new DatabaseSync(temporary, { readOnly: true });
        const result = restored.prepare('PRAGMA integrity_check').get();
        restored.close();
        if (String(Object.values(result || {})[0]) !== 'ok') throw new BackupError('backup_integrity_failed', 'restored database integrity check failed');
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return { targetPath: target, manifest: verified };
    }
  };
}

export async function verifyBackup(directory) {
  const root = resolve(directory);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new BackupError('backup_manifest_invalid', `backup manifest invalid: ${error.message}`);
  }
  if (manifest.schemaVersion !== 1 || basename(manifest.database?.file || '') !== manifest.database?.file) {
    throw new BackupError('backup_manifest_invalid', 'unsupported or unsafe backup manifest');
  }
  const databasePath = join(root, manifest.database.file);
  const metadata = await stat(databasePath).catch(() => null);
  if (!metadata || metadata.size !== manifest.database.size || await sha256File(databasePath) !== manifest.database.sha256) {
    throw new BackupError('backup_checksum_mismatch', 'backup database checksum mismatch');
  }
  const snapshot = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = snapshot.prepare('PRAGMA integrity_check').get();
    if (String(Object.values(result || {})[0]) !== 'ok') throw new BackupError('backup_integrity_failed', 'backup database integrity check failed');
  } finally {
    snapshot.close();
  }
  return manifest;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function safeSegment(value) {
  const segment = String(value || 'scheduled').replace(/[^A-Za-z0-9_.-]/g, '-');
  if (!segment || segment === '.' || segment === '..') throw new BackupError('backup_label_invalid', 'invalid backup label');
  return segment;
}

function sqliteQuote(path) {
  return String(path).replaceAll("'", "''");
}
