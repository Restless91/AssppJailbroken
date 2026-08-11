export function createOnlineDevicePool({
  listDevices,
  markOffline = async () => {},
  isUnavailable = (error) => error?.deviceUnavailable === true
}) {
  if (typeof listDevices !== 'function') {
    throw new TypeError('listDevices must be a function');
  }

  let cursor = 0;

  function configured(deviceId) {
    const id = String(deviceId || '').trim();
    if (!id) return null;
    return listDevices().find((device) => device.id === id) || null;
  }

  function strict(deviceId) {
    const device = configured(deviceId);
    if (!device) {
      const error = new Error('指定设备不存在或当前不可调度。');
      error.status = 404;
      throw error;
    }
    return device;
  }

  function onlineDevices() {
    return listDevices().filter((device) => device.online === true);
  }

  function optional(deviceId = null) {
    if (deviceId) return configured(deviceId);
    const devices = onlineDevices();
    if (!devices.length) return null;
    const device = devices[cursor % devices.length];
    cursor = (cursor + 1) % Math.max(1, devices.length);
    return device;
  }

  async function run(operation, { deviceId = null } = {}) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    if (deviceId) return operation(strict(deviceId));

    const devices = onlineDevices();
    if (!devices.length) throw noOnlineDeviceError();

    const start = cursor % devices.length;
    cursor = (cursor + 1) % devices.length;
    let lastError = null;

    for (let offset = 0; offset < devices.length; offset += 1) {
      const device = devices[(start + offset) % devices.length];
      try {
        return await operation(device);
      } catch (error) {
        if (!isUnavailable(error)) throw error;
        lastError = error;
        await markOffline(device, error);
      }
    }

    const error = noOnlineDeviceError();
    if (lastError) error.cause = lastError;
    throw error;
  }

  return {
    configured,
    strict,
    optional,
    run
  };
}

function noOnlineDeviceError() {
  const error = new Error('暂无在线设备，无法调用设备接口。');
  error.status = 503;
  error.code = 'NO_ONLINE_DEVICE';
  return error;
}
