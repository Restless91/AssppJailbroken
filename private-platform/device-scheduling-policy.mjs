import { evaluateDeviceDecryptReadiness } from './device-decrypt-readiness.mjs';
import { evaluateDeviceCompatibility } from './scheduler-policy.mjs';

const GIBIBYTE = 1024 * 1024 * 1024;

export function requiredDeviceFreeBytes(packageSize, config = {}) {
  const size = Math.max(0, Number(packageSize || 0));
  const minimum = Math.max(0, Number(config.minimumFreeBytes ?? 2 * GIBIBYTE));
  const multiplier = Math.max(1, Number(config.requiredSpaceMultiplier ?? 3));
  const overhead = Math.max(0, Number(config.storageOverheadBytes ?? 512 * 1024 * 1024));
  if (!Number.isFinite(size) || !Number.isFinite(minimum)
    || !Number.isFinite(multiplier) || !Number.isFinite(overhead)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(minimum, size * multiplier + overhead);
}

export function evaluateDeviceScheduling(device, job, config = {}) {
  const compatibility = evaluateDeviceCompatibility(device, job);
  if (!compatibility.compatible) return compatibility;

  const readiness = evaluateDeviceDecryptReadiness(device);
  if (!readiness.ready) return { eligible: false, ...readiness };

  const packageSize = Number(job?.software?.fileSizeBytes || 0);
  const availableBytes = Number(device?.freeBytes || 0);
  const requiredBytes = requiredDeviceFreeBytes(packageSize, config);
  if (packageSize > 0 && availableBytes > 0 && availableBytes < requiredBytes) {
    return {
      eligible: false,
      compatible: true,
      code: 'insufficient_storage',
      availableBytes,
      requiredBytes
    };
  }

  return {
    eligible: true,
    compatible: true,
    code: 'eligible',
    availableBytes: availableBytes || null,
    requiredBytes: packageSize > 0 ? requiredBytes : null
  };
}
