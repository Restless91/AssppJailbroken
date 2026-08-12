import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const temporaryPath = `${path}.${process.pid}.${suffix}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
