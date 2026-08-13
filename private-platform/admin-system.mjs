import { join } from 'node:path';
import { AdminDatabase } from './admin-db.mjs';
import { createAppleAccountAdminService } from './apple-account-admin.mjs';
import { WechatGatewayClient } from './wechat-gateway.mjs';

const ADMIN_COOKIE = 'asspp_admin_session';

export function createAdminSystem({
  rootDir,
  config,
  getJobs = () => [],
  countJobs = null,
  getJobSummaries = null,
  getJobDetail = null,
  adminJobAction = null,
  testStorage = null
}) {
  const databasePath = process.env.PLATFORM_DATABASE || join(rootDir, 'data', 'platform.sqlite');
  const store = new AdminDatabase({ path: databasePath, legacyConfig: config });
  const appleAccountAdmin = createAppleAccountAdminService({ store });
  let monitorTimer = null;
  const eventClients = new Set();
  const alertDedup = new Map();

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/admin/')) return false;

    if (url.pathname === '/api/admin/bootstrap/status' && req.method === 'GET') {
      sendJson(res, 200, {
        bootstrapRequired: store.bootstrapRequired(),
        databasePath,
        masterKeyConfigured: Boolean(process.env.PLATFORM_MASTER_KEY)
      });
      return true;
    }

    if (url.pathname === '/api/admin/bootstrap' && req.method === 'POST') {
      requireLegacyBootstrapToken(req, config);
      const body = await readJson(req);
      const bootstrap = store.createBootstrapAdmin(body);
      sendJson(res, 201, bootstrap);
      return true;
    }

    if (url.pathname === '/api/admin/bootstrap/confirm' && req.method === 'POST') {
      const body = await readJson(req);
      const result = store.confirmBootstrap({
        ...body,
        ipAddress: clientIP(req),
        userAgent: req.headers['user-agent']
      });
      setAdminCookie(res, result.session.token, result.session.expiresAt);
      sendJson(res, 200, { admin: result.admin, expiresAt: result.session.expiresAt });
      return true;
    }

    if (url.pathname === '/api/admin/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      const result = store.authenticateAdmin({
        ...body,
        ipAddress: clientIP(req),
        userAgent: req.headers['user-agent']
      });
      setAdminCookie(res, result.session.token, result.session.expiresAt);
      sendJson(res, 200, { admin: result.admin, expiresAt: result.session.expiresAt });
      return true;
    }

    if (url.pathname === '/api/admin/auth/me' && req.method === 'GET') {
      const admin = currentAdmin(req);
      sendJson(res, 200, { authenticated: Boolean(admin), admin });
      return true;
    }

    if (url.pathname === '/api/admin/auth/logout' && req.method === 'POST') {
      const token = cookie(req, ADMIN_COOKIE);
      const admin = store.adminForSession(token);
      store.deleteAdminSession(token, admin);
      clearAdminCookie(res);
      sendJson(res, 200, { ok: true });
      return true;
    }

    const admin = requireAdmin(req);

    if (url.pathname === '/api/admin/events' && req.method === 'GET') {
      startEventStream(req, res, admin);
      return true;
    }

    if (url.pathname === '/api/admin/admins' && req.method === 'GET') {
      sendJson(res, 200, store.listAdmins(admin));
      return true;
    }

    if (url.pathname === '/api/admin/admins' && req.method === 'POST') {
      const body = await readJson(req);
      sendJson(res, 201, store.createAdmin(body, admin));
      return true;
    }

    const adminMatch = url.pathname.match(/^\/api\/admin\/admins\/([^/]+)$/);
    if (adminMatch && req.method === 'PATCH') {
      const body = await readJson(req);
      sendJson(res, 200, store.updateAdmin(decodeURIComponent(adminMatch[1]), body, admin));
      return true;
    }

    if (url.pathname === '/api/admin/dashboard' && req.method === 'GET') {
      const devices = store.listDevices();
      const online = devices.filter((device) => device.online).length;
      const counts = countJobs ? countJobs() : fallbackJobCounts(getJobs());
      sendJson(res, 200, {
        devices: {
          total: devices.length,
          online,
          offline: devices.length - online,
          quarantined: devices.filter((device) => device.lifecycleState === 'quarantined').length,
          maintenance: devices.filter((device) => device.lifecycleState === 'maintenance').length
        },
        cards: store.listCardBatches().reduce((summary, batch) => ({
          batches: summary.batches + 1,
          available: summary.available + batch.availableCount,
          redeemed: summary.redeemed + batch.redeemedCount
        }), { batches: 0, available: 0, redeemed: 0 }),
        jobs: counts,
        masterKeyConfigured: Boolean(process.env.PLATFORM_MASTER_KEY)
      });
      return true;
    }

    if (url.pathname === '/api/admin/jobs' && req.method === 'GET') {
      sendJson(res, 200, getJobSummaries ? getJobSummaries() : getJobs().slice().reverse());
      return true;
    }

    const jobDetailMatch = url.pathname.match(/^\/api\/admin\/jobs\/([^/]+)$/);
    if (jobDetailMatch && req.method === 'GET') {
      const job = getJobDetail ? getJobDetail(decodeURIComponent(jobDetailMatch[1])) : null;
      if (!job) throw httpError(404, 'job not found');
      sendJson(res, 200, job);
      return true;
    }

    const jobActionMatch = url.pathname.match(/^\/api\/admin\/jobs\/([^/]+)\/(cancel|retry|lock)$/);
    if (jobActionMatch && req.method === 'POST') {
      store.requireRole(admin, 'operator');
      if (!adminJobAction) throw httpError(501, 'job administration is unavailable');
      const body = await readJson(req);
      const result = await adminJobAction({
        id: decodeURIComponent(jobActionMatch[1]),
        action: jobActionMatch[2],
        body,
        admin
      });
      store.audit({
        actorId: admin.id,
        actorUsername: admin.username,
        action: `job.${jobActionMatch[2]}`,
        targetType: 'job',
        targetId: jobActionMatch[1],
        summary: `任务操作：${jobActionMatch[2]}`
      });
      emit('jobs.changed', { id: jobActionMatch[1] });
      sendJson(res, 200, result);
      return true;
    }

    if (url.pathname === '/api/admin/device-groups' && req.method === 'GET') {
      sendJson(res, 200, store.listGroups());
      return true;
    }

    const groupMatch = url.pathname.match(/^\/api\/admin\/device-groups\/([^/]+)$/);
    if (groupMatch && req.method === 'PATCH') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const group = store.upsertGroup({
        ...body,
        id: decodeURIComponent(groupMatch[1])
      }, admin);
      emit('device-groups.changed', { id: group.id });
      sendJson(res, 200, group);
      return true;
    }

    if (url.pathname === '/api/admin/devices' && req.method === 'GET') {
      sendJson(res, 200, store.listDevices());
      return true;
    }

    if (url.pathname === '/api/admin/devices' && req.method === 'POST') {
      store.requireRole(admin, 'operator');
      const body = await readJson(req);
      const device = store.upsertDevice(body, admin);
      const probed = await probeAndPersist(device.id);
      emit('devices.changed', { id: device.id });
      sendJson(res, 201, probed);
      return true;
    }

    const deviceMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)$/);
    if (deviceMatch && req.method === 'DELETE') {
      store.requireRole(admin, 'super_admin');
      const id = decodeURIComponent(deviceMatch[1]);
      const blockingJob = getJobs().find((job) =>
        !['completed', 'failed', 'expired', 'cancelled', 'interrupted'].includes(job.status)
        && (job.deviceId === id || (job.deviceLock && job.preferredDeviceId === id))
      );
      if (blockingJob) throw httpError(409, `设备正被任务 ${blockingJob.id} 使用，暂不能删除`);
      const device = store.deleteDevice(id, admin);
      emit('devices.changed', { id, deleted: true });
      sendJson(res, 200, { deleted: true, id: device.id });
      return true;
    }
    if (deviceMatch && req.method === 'PATCH') {
      store.requireRole(admin, 'operator');
      const id = decodeURIComponent(deviceMatch[1]);
      const existing = store.device(id, { includeSecrets: true });
      if (!existing) throw httpError(404, 'device not found');
      const body = await readJson(req);
      const device = store.upsertDevice({ ...existing, ...body, id }, admin);
      emit('devices.changed', { id });
      sendJson(res, 200, device);
      return true;
    }

    const probeMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/probe$/);
    if (probeMatch && req.method === 'POST') {
      store.requireRole(admin, 'operator');
      const device = await probeAndPersist(decodeURIComponent(probeMatch[1]));
      emit('devices.changed', { id: device.id });
      sendJson(res, 200, device);
      return true;
    }

    if (url.pathname === '/api/admin/apple-accounts' && req.method === 'GET') {
      store.requireRole(admin, 'operator');
      sendJson(res, 200, store.listAppleAccounts());
      return true;
    }

    if (url.pathname === '/api/admin/apple-accounts/authenticate' && req.method === 'POST') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const result = await appleAccountAdmin.authenticate({ ...body, actor: admin });
      if (!result.codeRequired) emit('apple-accounts.changed', { id: result.account.id });
      sendJson(res, result.codeRequired ? 202 : 201, result);
      return true;
    }

    if (url.pathname === '/api/admin/apple-accounts/sync-device' && req.method === 'POST') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const accounts = await appleAccountAdmin.syncDeviceAccount({ ...body, actor: admin });
      for (const account of accounts) emit('apple-accounts.changed', { id: account.id });
      sendJson(res, 201, { accounts, count: accounts.length });
      return true;
    }

    if (url.pathname === '/api/admin/apple-accounts' && req.method === 'POST') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const account = store.upsertAppleAccount(body, admin);
      emit('apple-accounts.changed', { id: account.id });
      sendJson(res, 201, account);
      return true;
    }

    const accountMatch = url.pathname.match(/^\/api\/admin\/apple-accounts\/([^/]+)$/);
    if (accountMatch && req.method === 'DELETE') {
      store.requireRole(admin, 'super_admin');
      const id = decodeURIComponent(accountMatch[1]);
      const account = store.deleteAppleAccount(id, admin);
      emit('apple-accounts.changed', { id, deleted: true });
      sendJson(res, 200, { deleted: true, id: account.id });
      return true;
    }
    if (accountMatch && req.method === 'PATCH') {
      store.requireRole(admin, 'super_admin');
      const id = decodeURIComponent(accountMatch[1]);
      const existing = store.appleAccount(id, { includeSecret: true });
      if (!existing) throw httpError(404, 'Apple ID not found');
      const body = await readJson(req);
      const account = store.upsertAppleAccount({
        ...existing,
        ...body,
        id,
        account: body.account || existing.account
      }, admin);
      emit('apple-accounts.changed', { id });
      sendJson(res, 200, account);
      return true;
    }

    if (url.pathname === '/api/admin/cards/batches' && req.method === 'GET') {
      sendJson(res, 200, store.listCardBatches());
      return true;
    }

    if (url.pathname === '/api/admin/users/credits' && req.method === 'GET') {
      sendJson(res, 200, store.listUserCredits(admin, url.searchParams.get('limit') || 500));
      return true;
    }

    if (url.pathname === '/api/admin/cards/batches' && req.method === 'POST') {
      const body = await readJson(req);
      const batch = store.createCardBatch(body, admin);
      emit('cards.changed', { id: batch.id });
      sendJson(res, 201, batch);
      return true;
    }

    const cardsMatch = url.pathname.match(/^\/api\/admin\/cards\/batches\/([^/]+)\/cards$/);
    if (cardsMatch && req.method === 'GET') {
      sendJson(res, 200, store.listCards(decodeURIComponent(cardsMatch[1]), admin));
      return true;
    }

    if (url.pathname === '/api/admin/settings/cards' && req.method === 'GET') {
      store.requireRole(admin, 'operator');
      sendJson(res, 200, normalizeCardSettings(store.getSetting('cards', config.cards || {})));
      return true;
    }

    if (url.pathname === '/api/admin/settings/cards' && req.method === 'PATCH') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const value = normalizeCardSettings({
        ...store.getSetting('cards', config.cards || {}),
        ...body
      });
      store.setSetting('cards', value, admin);
      emit('settings.changed', { key: 'cards' });
      sendJson(res, 200, value);
      return true;
    }

    if (url.pathname === '/api/admin/settings/storage' && req.method === 'GET') {
      store.requireRole(admin, 'operator');
      sendJson(res, 200, maskStorageSettings(store.getSetting('storage', config.storage || {})));
      return true;
    }

    if (url.pathname === '/api/admin/settings/storage' && req.method === 'PATCH') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const existing = store.getSetting('storage', config.storage || {});
      const value = mergeSecretSettings(existing, body, [
        ['cos', 'secretId'],
        ['cos', 'secretKey'],
        ['fallbackCos', 'secretId'],
        ['fallbackCos', 'secretKey']
      ]);
      store.setSetting('storage', value, admin, true);
      emit('settings.changed', { key: 'storage' });
      sendJson(res, 200, maskStorageSettings(value));
      return true;
    }

    if (url.pathname === '/api/admin/settings/storage/test' && req.method === 'POST') {
      store.requireRole(admin, 'operator');
      if (!testStorage) throw httpError(501, '存储测试不可用');
      const body = await readJson(req);
      sendJson(res, 200, await testStorage(body));
      return true;
    }

    if (url.pathname === '/api/admin/settings/scheduler' && req.method === 'GET') {
      store.requireRole(admin, 'operator');
      sendJson(res, 200, schedulerSettings());
      return true;
    }

    if (url.pathname === '/api/admin/settings/scheduler' && req.method === 'PATCH') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const value = {
        ...schedulerSettings(),
        ...body
      };
      store.setSetting('scheduler', value, admin);
      emit('settings.changed', { key: 'scheduler' });
      sendJson(res, 200, value);
      return true;
    }

    if (url.pathname === '/api/admin/settings/notifications' && req.method === 'GET') {
      store.requireRole(admin, 'operator');
      const value = store.getSetting('notifications', {
        wechat: config.wechat || {},
        wecomRobots: []
      });
      sendJson(res, 200, maskNotificationSettings(value));
      return true;
    }

    if (url.pathname === '/api/admin/settings/notifications' && req.method === 'PATCH') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const existing = store.getSetting('notifications', {
        wechat: config.wechat || {},
        wecomRobots: []
      });
      const value = mergeNotificationSecrets(existing, body);
      store.setSetting('notifications', value, admin, true);
      emit('settings.changed', { key: 'notifications' });
      sendJson(res, 200, maskNotificationSettings(value));
      return true;
    }

    if (url.pathname === '/api/admin/settings/notifications/test' && req.method === 'POST') {
      store.requireRole(admin, 'operator');
      await sendWecomAlert({
        severity: 'warning',
        title: '91iOS Dump 管理平台测试通知',
        detail: `由管理员 ${admin.username} 触发，时间 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        force: true
      });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/admin/settings/wechat-gateway' && req.method === 'GET') {
      store.requireRole(admin, 'operator');
      const value = store.getSetting('wechatGateway', config.wechatGateway || {});
      sendJson(res, 200, {
        ...value,
        clientSecret: value.clientSecret ? '••••••••' : '',
        secretConfigured: Boolean(value.clientSecret)
      });
      return true;
    }

    if (url.pathname === '/api/admin/settings/wechat-gateway' && req.method === 'PATCH') {
      store.requireRole(admin, 'super_admin');
      const body = await readJson(req);
      const existing = store.getSetting('wechatGateway', config.wechatGateway || {});
      const value = {
        ...existing,
        ...body,
        clientSecret: !body.clientSecret || body.clientSecret === '••••••••'
          ? existing.clientSecret || ''
          : body.clientSecret
      };
      store.setSetting('wechatGateway', value, admin, true);
      emit('settings.changed', { key: 'wechatGateway' });
      sendJson(res, 200, {
        ...value,
        clientSecret: value.clientSecret ? '••••••••' : '',
        secretConfigured: Boolean(value.clientSecret)
      });
      return true;
    }

    if (url.pathname === '/api/admin/settings/wechat-gateway/test' && req.method === 'POST') {
      store.requireRole(admin, 'operator');
      const value = store.getSetting('wechatGateway', config.wechatGateway || {});
      const result = await new WechatGatewayClient(value).request('/internal/v1/health');
      sendJson(res, 200, result);
      return true;
    }

    if (url.pathname === '/api/admin/audit' && req.method === 'GET') {
      store.requireRole(admin, 'auditor');
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 100)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      sendJson(res, 200, store.listAuditLogs({ limit, offset }));
      return true;
    }

    sendJson(res, 404, { error: 'not found' });
    return true;
  }

  function currentAdmin(req) {
    return store.adminForSession(cookie(req, ADMIN_COOKIE));
  }

  function requireAdmin(req) {
    const admin = currentAdmin(req);
    if (!admin) throw httpError(401, 'administrator session required');
    return admin;
  }

  function fallbackJobCounts(jobs) {
    return {
      queued: jobs.filter((job) => job.status === 'queued').length,
      active: jobs.filter((job) => ['running', 'downloading', 'decrypting', 'uploading'].includes(job.status)).length,
      completed: jobs.filter((job) => job.status === 'completed').length,
      failed: jobs.filter((job) => ['failed', 'interrupted', 'needs_verification'].includes(job.status)).length
    };
  }

  async function probeAndPersist(id) {
    const device = store.device(id, { includeSecrets: true });
    if (!device) throw httpError(404, 'device not found');
    try {
      const info = await fetchDeviceInfo(device);
      return store.updateDeviceProbe(id, { ...info, online: true });
    } catch (error) {
      store.updateDeviceProbe(id, { online: false, error: error.message || String(error) });
      throw httpError(502, `设备探测失败：${error.message || String(error)}`);
    }
  }

  async function monitorDevices() {
    const devices = store.listDevices({ includeSecrets: true }).filter((device) => device.enabled);
    await Promise.allSettled(devices.map(async (device) => {
      const before = store.device(device.id);
      try {
        const info = await fetchDeviceInfo(device);
        const after = store.updateDeviceProbe(device.id, { ...info, online: true });
        if (before?.online === false && before.lastSeenAt && after.online) {
          await sendWecomAlert({
            severity: 'warning',
            title: 'iPhone 节点已恢复',
            detail: `${after.name}（${after.baseUrl}）恢复在线`
          });
        }
      } catch (error) {
        const after = store.updateDeviceProbe(device.id, { online: false, error: error.message || String(error) });
        if (before?.online || after.lifecycleState === 'quarantined') {
          await sendWecomAlert({
            severity: after.lifecycleState === 'quarantined' ? 'critical' : 'warning',
            title: after.lifecycleState === 'quarantined' ? 'iPhone 节点已自动隔离' : 'iPhone 节点离线',
            detail: `${after.name}（${after.baseUrl}）：${after.lastError || '无法连接'}`
          });
        }
      }
    }));
    emit('devices.snapshot', { devices: store.listDevices() });
  }

  function startMonitor() {
    if (monitorTimer) return;
    monitorDevices().catch(console.error);
    monitorTimer = setInterval(() => monitorDevices().catch(console.error), 15_000);
    monitorTimer.unref?.();
  }

  function startEventStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
    const client = { res };
    eventClients.add(client);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      eventClients.delete(client);
    });
  }

  function emit(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of eventClients) {
      try {
        client.res.write(payload);
      } catch {
        eventClients.delete(client);
      }
    }
  }

  async function sendWecomAlert({ severity, title, detail, force = false }) {
    const notifications = store.getSetting('notifications', { wecomRobots: [] }) || {};
    const robots = (notifications.wecomRobots || []).filter((robot) =>
      robot.enabled !== false && robot.webhook &&
      (robot.minimumSeverity !== 'critical' || severity === 'critical')
    );
    if (!robots.length) {
      if (force) throw httpError(409, '尚未配置启用的企业微信机器人');
      return;
    }
    await Promise.all(robots.map(async (robot) => {
      const key = `${robot.id || robot.name || 'robot'}:${severity}:${title}:${detail}`;
      const windowMs = Math.max(1, Number(robot.dedupMinutes || 30)) * 60_000;
      if (!force && Date.now() - Number(alertDedup.get(key) || 0) < windowMs) return;
      const response = await fetch(robot.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: {
            content: `### ${title}\n> 级别：<font color="${severity === 'critical' ? 'warning' : 'comment'}">${severity}</font>\n> ${detail}`
          }
        }),
        signal: AbortSignal.timeout(8_000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.errcode) {
        throw new Error(`企业微信机器人发送失败：${result.errmsg || response.status}`);
      }
      alertDedup.set(key, Date.now());
    }));
  }

  function schedulerSettings() {
    const stored = store.getSetting('scheduler', {}) || {};
    const storageBudget = Number(stored.storageBudgetVersion || 0) >= 2
      ? {}
      : {
          minimumFreeBytes: 2 * 1024 * 1024 * 1024,
          requiredSpaceMultiplier: 3,
          storageOverheadBytes: 512 * 1024 * 1024,
          storageBudgetVersion: 2
        };
    return {
      maxAttemptsPerDevice: 2,
      maxDevicesPerJob: 3,
      maxAttemptsPerJob: 5,
      minimumFreeBytes: 2 * 1024 * 1024 * 1024,
      requiredSpaceMultiplier: 3,
      storageOverheadBytes: 512 * 1024 * 1024,
      storageBudgetVersion: 2,
      skipExtensions: false,
      ...stored,
      ...storageBudget
    };
  }

  function effectiveDeviceConfig(device) {
    const group = store.listGroups().find((item) => item.id === device.groupId);
    return deepMerge(deepMerge(schedulerSettings(), group?.config || {}), device.config || {});
  }

  return {
    handle,
    startMonitor,
    store,
    currentAdmin,
    schedulingDevices: () => store.schedulingDevices(),
    publicDevices: () => store.listDevices(),
    schedulerSettings,
    effectiveDeviceConfig,
    notifyOperations: sendWecomAlert
  };
}

async function fetchDeviceInfo(device) {
  const headers = {};
  if (device.accessToken) headers['X-Access-Token'] = device.accessToken;
  const options = { headers, signal: AbortSignal.timeout(5_000) };
  let response = await fetch(`${device.baseUrl}/api/node/info`, options);
  if (response.status === 404) {
    response = await fetch(`${device.baseUrl}/health`, options);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${String(await response.text()).slice(0, 400)}`);
  }
  const value = await response.json();
  return normalizeNodeInfo(value);
}

function normalizeNodeInfo(value) {
  const storage = value.storage || {};
  const vnode = value.vnode || {};
  const build = value.build || {};
  const runtime = value.runtime || {};
  return {
    machineIdentifier: value.machineIdentifier || value.machine_identifier || null,
    modelName: value.modelName || value.model_name || null,
    iosVersion: value.iosVersion || value.ios_version || null,
    jailbreakRuntime: runtime.jailbreak || value.jailbreakRuntime || null,
    providerName: runtime.provider || value.providerName || null,
    buildCommit: build.commit || value.build_commit || null,
    buildTimestamp: build.timestamp || value.build_timestamp || null,
    capabilities: value.capabilities || {},
    totalBytes: storage.totalBytes ?? value.totalBytes ?? null,
    freeBytes: storage.freeBytes ?? value.freeBytes ?? null,
    vnodeCurrent: vnode.current ?? value.vnodeCurrent ?? null,
    vnodeLimit: vnode.limit ?? value.vnodeLimit ?? null,
    thermalState: value.thermalState || value.thermal_state || null
  };
}

function requireLegacyBootstrapToken(req, config) {
  if (!config.adminToken) return;
  const token = req.headers['x-admin-token'];
  if (token !== config.adminToken) throw httpError(401, 'legacy admin token required for bootstrap');
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) throw httpError(413, 'request body is too large');
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw httpError(400, 'invalid JSON body');
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function setAdminCookie(res, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const secure = String(process.env.PUBLIC_BASE_URL || '').startsWith('https://') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure}`
  );
}

function clearAdminCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`
  );
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

function clientIP(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').slice(0, 100);
}

function maskStorageSettings(storage) {
  return {
    ...storage,
    cos: maskCos(storage?.cos),
    fallbackCos: maskCos(storage?.fallbackCos)
  };
}

function normalizeCardSettings(value = {}) {
  const purchaseUrl = String(value.purchaseUrl || '').trim();
  if (purchaseUrl) {
    let parsed;
    try {
      parsed = new URL(purchaseUrl);
    } catch {
      throw httpError(400, '购买链接格式不正确');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw httpError(400, '购买链接仅支持 HTTP 或 HTTPS');
    }
  }
  return {
    purchaseUrl,
    purchaseHint: String(
      value.purchaseHint || '请在微信公众号回复“购买兑换码”获取购买方式'
    ).trim().slice(0, 300)
  };
}

function maskCos(cos = {}) {
  return {
    ...cos,
    secretId: cos.secretId ? '••••••••' : '',
    secretKey: cos.secretKey ? '••••••••' : '',
    secretConfigured: Boolean(cos.secretId && cos.secretKey)
  };
}

function mergeSecretSettings(existing, next, paths) {
  const value = structuredClone(existing || {});
  deepMerge(value, next || {});
  for (const path of paths) {
    const incoming = getPath(next, path);
    if (incoming === undefined || incoming === '' || incoming === '••••••••') {
      setPath(value, path, getPath(existing, path));
    }
  }
  return value;
}

function maskNotificationSettings(value = {}) {
  return {
    ...value,
    wechat: {
      ...(value.wechat || {}),
      appSecret: value.wechat?.appSecret ? '••••••••' : '',
      token: value.wechat?.token ? '••••••••' : '',
      encodingAESKey: value.wechat?.encodingAESKey ? '••••••••' : ''
    },
    wecomRobots: (value.wecomRobots || []).map((robot) => ({
      ...robot,
      webhook: robot.webhook ? `${String(robot.webhook).slice(0, 34)}••••••••` : '',
      webhookConfigured: Boolean(robot.webhook)
    }))
  };
}

function mergeNotificationSecrets(existing, next) {
  const value = structuredClone(existing || {});
  deepMerge(value, next || {});
  for (const key of ['appSecret', 'token', 'encodingAESKey']) {
    const incoming = next?.wechat?.[key];
    if (incoming === undefined || incoming === '' || incoming === '••••••••') {
      if (!value.wechat) value.wechat = {};
      value.wechat[key] = existing?.wechat?.[key] || '';
    }
  }
  const oldRobots = new Map((existing?.wecomRobots || []).map((robot) => [robot.id, robot]));
  value.wecomRobots = (next?.wecomRobots || existing?.wecomRobots || []).map((robot) => {
    const old = oldRobots.get(robot.id);
    if (!robot.webhook || String(robot.webhook).includes('••••')) {
      return { ...robot, webhook: old?.webhook || '' };
    }
    return robot;
  });
  return value;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function getPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function setPath(value, path, next) {
  let current = value;
  for (let index = 0; index < path.length - 1; index += 1) {
    current[path[index]] ||= {};
    current = current[path[index]];
  }
  current[path.at(-1)] = next;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
