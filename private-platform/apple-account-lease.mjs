import { randomUUID } from 'node:crypto';

export async function withAppleAccountLease({
  store,
  device,
  purpose = 'manual',
  preferredId = null,
  storefront = null,
  operation
}) {
  const leaseJobId = `${purpose}-${randomUUID()}`;
  const leased = store.acquireAppleAccount({
    deviceId: device.id,
    jobId: leaseJobId,
    preferredId,
    storefront,
    leaseMinutes: 10
  });
  if (!leased?.account) {
    const error = new Error(storefront
      ? '后台未配置该地区的Apple id账号，无法进行下载操作。'
      : '没有可用于该设备的 Apple ID 账户，请在管理后台启用全局账号或绑定账号到该设备。');
    error.status = 409;
    throw error;
  }

  try {
    const result = await operation(leased.account, leased);
    if (result?.account && typeof result.account === 'object') {
      store.upsertAppleAccount({
        id: leased.id,
        label: leased.label,
        account: result.account,
        accountHash: leased.accountHash,
        storefront: leased.storefront,
        priority: leased.priority,
        enabled: leased.enabled,
        isGlobalDefault: leased.isGlobalDefault,
        deviceIds: leased.deviceIds
      });
    }
    store.releaseAppleAccount(leaseJobId);
    return result && typeof result === 'object'
      ? { ...result, account: result.account || leased.account }
      : result;
  } catch (error) {
    store.releaseAppleAccount(leaseJobId, error?.message || String(error));
    throw error;
  }
}
