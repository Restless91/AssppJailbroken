import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, stat, statfs, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export class StorageLifecycleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StorageLifecycleError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function requiredRouterBytes({ artifactBytes, workingCopies = 2, overheadBytes = 512 * 1024 * 1024 }) {
  const size = finiteNonNegative(artifactBytes);
  const copies = finiteNonNegative(workingCopies);
  const overhead = finiteNonNegative(overheadBytes);
  const required = size * copies + overhead;
  return Number.isSafeInteger(required) ? required : Number.MAX_SAFE_INTEGER;
}

export function planStorageReconciliation(expectedReceipts = [], observedArtifacts = []) {
  const observedByIdentity = new Map(observedArtifacts.map((item) => [storageIdentity(item), item]));
  const expectedIdentities = new Set();
  const healthy = [];
  const missing = [];
  const mismatched = [];

  for (const expected of expectedReceipts) {
    const identity = storageIdentity(expected);
    expectedIdentities.add(identity);
    const observed = observedByIdentity.get(identity);
    if (!observed) {
      missing.push(expected);
      continue;
    }
    const fields = ['size', 'sha256'].filter((field) =>
      expected[field] != null && observed[field] != null && expected[field] !== observed[field]);
    if (fields.length) mismatched.push({ expected, observed, fields });
    else healthy.push({ expected, observed });
  }

  return {
    healthy,
    missing,
    mismatched,
    orphaned: observedArtifacts.filter((item) => !expectedIdentities.has(storageIdentity(item)))
  };
}

export function createStorageLifecycle({
  rootDir,
  availableBytes = filesystemAvailableBytes,
  deleteArtifact = null,
  now = () => new Date()
}) {
  if (!rootDir) throw new TypeError('rootDir is required');
  if (typeof availableBytes !== 'function') throw new TypeError('availableBytes is required');
  const remove = deleteArtifact || ((receipt) => deleteLocalArtifact(rootDir, receipt));

  let reservedBytes = 0;

  return {
    requiredBytes: requiredRouterBytes,
    async reserve(budget) {
      const requiredBytes = requiredRouterBytes(budget);
      const freeBytes = finiteNonNegative(await availableBytes(rootDir));
      if (requiredBytes > freeBytes - reservedBytes) {
        throw new StorageLifecycleError('insufficient_storage', 'router storage reservation unavailable', {
          availableBytes: freeBytes,
          reservedBytes,
          requiredBytes
        });
      }
      reservedBytes += requiredBytes;
      let released = false;
      return Object.freeze({
        requiredBytes,
        release() {
          if (released) return;
          released = true;
          reservedBytes = Math.max(0, reservedBytes - requiredBytes);
        }
      });
    },
    async stage({ sourcePath, artifactId }) {
      const safeId = safeSegment(artifactId, 'artifactId');
      const stagingDir = join(rootDir, '.staging');
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      const path = join(stagingDir, `${safeId}-${randomUUID()}.part`);
      try {
        await copyFile(sourcePath, path);
        await syncPath(path);
        const metadata = await stat(path);
        return Object.freeze({
          path,
          size: metadata.size,
          sha256: await sha256File(path)
        });
      } catch (error) {
        await unlink(path).catch(() => {});
        throw error;
      }
    },
    async publish(staged, { fileName }) {
      const safeName = safeSegment(fileName, 'fileName');
      const destination = join(rootDir, safeName);
      await mkdir(rootDir, { recursive: true });
      await rename(staged.path, destination);
      await syncPath(rootDir);
      return Object.freeze({
        provider: 'local',
        path: destination,
        fileName: safeName,
        size: staged.size,
        sha256: staged.sha256,
        publishedAt: now().toISOString()
      });
    },
    async discard(staged) {
      const stagingRoot = resolve(rootDir, '.staging');
      const stagedPath = resolve(staged?.path || '');
      if (!stagedPath.startsWith(`${stagingRoot}/`)) {
        throw new StorageLifecycleError('invalid_storage_path', 'staged artifact is outside staging root');
      }
      await unlink(stagedPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    },
    async expire(receipt) {
      try {
        await remove(receipt);
        return Object.freeze({ status: 'deleted', retryable: false, receipt });
      } catch (error) {
        return Object.freeze({
          status: 'delete_failed',
          retryable: true,
          receipt,
          error: Object.freeze({
            code: String(error?.code || 'storage_delete_failed'),
            message: String(error?.message || error)
          })
        });
      }
    }
  };
}

async function deleteLocalArtifact(rootDir, receipt) {
  if (receipt?.provider !== 'local' || !receipt?.path) {
    throw new StorageLifecycleError('unsupported_storage_provider', 'delete adapter unavailable');
  }
  const expectedPath = resolve(rootDir, safeSegment(receipt.fileName, 'fileName'));
  if (resolve(receipt.path) !== expectedPath) {
    throw new StorageLifecycleError('invalid_storage_path', 'artifact path is outside storage root');
  }
  await unlink(expectedPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

async function filesystemAvailableBytes(path) {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function syncPath(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function safeSegment(value, label) {
  const segment = String(value || '');
  if (!segment || basename(segment) !== segment || segment === '.' || segment === '..') {
    throw new StorageLifecycleError('invalid_storage_path', `${label} must be a single path segment`);
  }
  return segment;
}

function storageIdentity(item) {
  const provider = String(item?.provider || 'local');
  const locator = provider === 'local' ? item?.path : item?.key;
  if (!locator) throw new StorageLifecycleError('invalid_storage_receipt', 'storage receipt has no locator');
  return `${provider}:${locator}`;
}

function finiteNonNegative(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor(number);
}
