const MIB = 1024 * 1024;

export function buildDeviceCapabilityProfile(device, jobs = [], job = null) {
  const generation = deviceGeneration(device);
  const history = summarizeAttempts(device?.id, jobs);
  const requestedPolicy = normalizePolicy(job?.extensionDecryptionPolicy);
  const effectivePolicy = requestedPolicy || defaultPolicy(generation);
  const thermal = String(device?.thermalState || 'unknown').toLowerCase();
  const vnodeRatio = ratio(device?.vnodeCurrent, device?.vnodeLimit);
  const strictUnavailable = effectivePolicy === 'strict' && device?.capabilities?.extensionDecryption === false;
  const reason = ['critical', 'serious'].includes(thermal)
    ? 'thermal_pressure'
    : vnodeRatio >= 0.9
      ? 'vnode_pressure'
      : strictUnavailable ? 'extension_decryption_unavailable' : null;
  const packageBytes = Number(job?.software?.fileSizeBytes || 0);
  let batchSize = { iphone15: 8, iphone11: 4, iphone8: 2, unknown: 2 }[generation];
  if (history.memoryPressure > 0 || packageBytes >= 800 * MIB && generation !== 'iphone15') batchSize = Math.max(1, batchSize / 2);
  const successRate = history.total ? history.completed / history.total : 0.5;
  let score = { iphone15: 40, iphone11: 25, iphone8: 15, unknown: 10 }[generation];
  score += Math.round(successRate * 30);
  score -= history.memoryPressure * 8 + history.runtimeFailures * 5;
  if (packageBytes >= 800 * MIB) score += generation === 'iphone15' ? 30 : -20;
  if (thermal === 'fair') score -= 15;
  if (reason) score = Number.NEGATIVE_INFINITY;
  return {
    eligible: reason === null,
    reason: reason || 'eligible',
    generation,
    provider: device?.providerName || 'unknown',
    batchSize: Math.max(1, Math.floor(batchSize)),
    extensionPolicy: effectivePolicy,
    score,
    successRate,
    attempts: history.total,
    memoryPressureCount: history.memoryPressure,
    vnodeRatio: vnodeRatio || null,
    thermalState: thermal
  };
}

function summarizeAttempts(deviceId, jobs) {
  const attempts = (jobs || []).flatMap((item) => item.attempts || []).filter((attempt) => attempt.deviceId === deviceId);
  return attempts.reduce((value, attempt) => {
    value.total += 1;
    if (attempt.status === 'completed') value.completed += 1;
    if (attempt.errorCode === 'memory_pressure' || attempt.errorCode === 'iphone_decrypt_interrupted') value.memoryPressure += 1;
    if (['device_runtime_failed', 'install_provider_unavailable'].includes(attempt.errorCode)) value.runtimeFailures += 1;
    return value;
  }, { total: 0, completed: 0, memoryPressure: 0, runtimeFailures: 0 });
}

function deviceGeneration(device) {
  const value = `${device?.modelName || ''} ${device?.machineIdentifier || ''}`.toLowerCase();
  if (value.includes('iphone 15') || /iphone1[56],/.test(value)) return 'iphone15';
  if (value.includes('iphone 11') || value.includes('iphone12,1')) return 'iphone11';
  if (value.includes('iphone 8') || value.includes('iphone10,')) return 'iphone8';
  return 'unknown';
}

function defaultPolicy(generation) {
  return generation === 'iphone8' ? 'main_only' : 'compatible';
}

function normalizePolicy(value) {
  return ['main_only', 'compatible', 'strict'].includes(value) ? value : null;
}

function ratio(current, limit) {
  const denominator = Number(limit || 0);
  return denominator > 0 ? Number(current || 0) / denominator : 0;
}
