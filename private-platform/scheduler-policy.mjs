export function evaluateDeviceCompatibility(device, job) {
  const minimumOsVersion = String(
    job?.software?.minimumOsVersion
      || job?.software?.minimumOSVersion
      || ''
  ).trim();
  const deviceIosVersion = String(device?.iosVersion || '').trim();
  if (minimumOsVersion && !deviceIosVersion) {
    return {
      compatible: false,
      code: 'device_ios_unknown',
      minimumOsVersion,
      deviceIosVersion
    };
  }
  if (minimumOsVersion && deviceIosVersion
    && compareVersions(deviceIosVersion, minimumOsVersion) < 0) {
    return {
      compatible: false,
      code: 'ios_too_old',
      minimumOsVersion,
      deviceIosVersion
    };
  }
  return {
    compatible: true,
    code: 'compatible',
    minimumOsVersion,
    deviceIosVersion
  };
}

export function compareVersions(left, right) {
  const a = String(left || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const b = String(right || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
