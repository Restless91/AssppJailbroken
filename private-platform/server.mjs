import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile, stat, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import { syncBrowserAccount } from './browser-account-sync.mjs';
import { createAdminSystem } from './admin-system.mjs';
import { consumeNotificationMessage, notificationWindowStatus, refreshedNotificationWindow } from './notification-window.mjs';
import {
  cosAuthorization,
  cosSignedDownloadUrl as buildCosSignedDownloadUrl,
  encodeCosPath
} from './cos-signing.mjs';
import { evaluateDeviceCompatibility } from './scheduler-policy.mjs';
import { evaluateDeviceScheduling } from './device-scheduling-policy.mjs';
import { JobJournal } from './job-journal.mjs';
import { createBackupManager } from './backup-manager.mjs';
import { admitJob, canDispatchJob, fairQueueOrder } from './scheduler-engine.mjs';
import { createStorageLifecycle } from './storage-lifecycle.mjs';
import { verifyGatewaySignature, WechatGatewayClient } from './wechat-gateway.mjs';
import {
  updateFromDeviceTask,
  updateWorkflowProgress,
  workflowProgressView
} from './workflow-progress.mjs';
import { withAppleAccountLease } from './apple-account-lease.mjs';
import { normalizeStorefront, storefrontLabel } from './storefronts.mjs';
import {
  describeDownloadMaterialsShape,
  normalizeAppleDownloadMaterials
} from './apple-download-materials.mjs';
import { extractErrorMessage, readErrorMessage } from './error-message.mjs';
import { createOnlineDevicePool } from './device-pool.mjs';
import { createHealthModel, createMetricsRegistry } from './observability.mjs';
import { constantTimeEqual, createRateLimiter, readBoundedBody, requireHeaderToken, validateCredentialConfig, validateMutationOrigin } from './request-security.mjs';

const rootDir = new URL('.', import.meta.url).pathname;
const configPath = process.env.PLATFORM_CONFIG || join(rootDir, 'config.json');
const appsPath = process.env.PLATFORM_APPS || join(rootDir, 'apps.json');
const statePath = process.env.PLATFORM_STATE || join(rootDir, 'data', 'state.json');

validateCredentialConfig({
  production: process.env.NODE_ENV === 'production',
  masterKey: process.env.PLATFORM_MASTER_KEY
});

const config = await loadJson(configPath, join(rootDir, 'config.example.json'));
const apps = await loadJson(appsPath, join(rootDir, 'apps.json'));
const serverPort = Math.max(1, Number(process.env.PORT || config.port || 8090));
const state = await loadState();
function countJobs() {
  let queued = 0;
  let active = 0;
  let completed = 0;
  let failed = 0;
  for (const job of state.jobs) {
    if (job.status === 'queued') queued += 1;
    else if (activeJobStatuses.has(job.status)) active += 1;
    else if (job.status === 'completed') completed += 1;
    else if (['failed', 'interrupted', 'needs_verification'].includes(job.status)) failed += 1;
  }
  return { queued, active, completed, failed };
}

function getJobSummaries() {
  const queueState = buildQueueState();
  return state.jobs.map((job) => summarizeJob(job, queueState)).reverse();
}

function summarizeJob(job, queueState) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    app: job.app,
    deviceId: job.deviceId,
    appleAccountLabel: job.appleAccountLabel,
    error: job.error,
    errorCode: job.errorCode,
    attemptCount: Array.isArray(job.attempts) ? job.attempts.length : 0,
    queue: queueInfoForJob(job, queueState)
  };
}

function getJobDetail(id) {
  const job = state.jobs.find((item) => item.id === id);
  return job ? enrichJob(job) : null;
}

const adminSystem = createAdminSystem({
  rootDir,
  config,
  getJobs: () => state.jobs.map((job) => enrichJob(job)),
  countJobs,
  getJobSummaries,
  getJobDetail,
  adminJobAction,
  testStorage
});
const jobJournal = new JobJournal(adminSystem.store.db);
const backupManager = createBackupManager({
  database: adminSystem.store.db,
  databasePath: process.env.PLATFORM_DATABASE || join(rootDir, 'data', 'platform.sqlite'),
  backupRoot: process.env.PLATFORM_BACKUP_DIR || join(rootDir, 'data', 'backups')
});
jobJournal.importLegacy(state.jobs);
const journalJobs = jobJournal.list();
if (journalJobs.length) state.jobs = journalJobs;
const devicePool = createOnlineDevicePool({
  listDevices: () => adminSystem.schedulingDevices(),
  isUnavailable: isDeviceUnavailableError,
  markOffline: async (device, error) => {
    adminSystem.store.updateDeviceProbe(device.id, {
      online: false,
      error: error?.message || String(error)
    });
  }
});
const metrics = createMetricsRegistry({ allowedLabels: ['method', 'result'] });
const publicRateLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const artifactDirectory = resolvePath(storageConfig().localDir || './data/artifacts');
const storageLifecycle = createStorageLifecycle({ rootDir: artifactDirectory });
const health = createHealthModel({
  database: async () => {
    adminSystem.store.listDevices();
    return { ok: true };
  },
  storage: async () => {
    const value = await statfs(resolvePath(storageConfig().localDir || './data/artifacts'));
    const freeBytes = Number(value.bavail) * Number(value.bsize);
    const minimumBytes = Math.max(64, Number(config.readinessMinimumFreeMB || 512)) * 1024 * 1024;
    return { ok: freeBytes >= minimumBytes, freeBytes, minimumBytes };
  },
  devicePool: async () => {
    const devices = adminSystem.publicDevices();
    return { ok: true, configured: devices.length, online: devices.filter((device) => device.online).length };
  }
});
const runningJobs = new Set();
const topAppsCache = new Map();
const historicalVersionsCache = new Map();
const versionInfoCache = new Map();
const wechatAccessTokenCache = { token: '', expiresAt: 0 };
const activeJobStatuses = new Set(['running', 'downloading', 'decrypting', 'uploading']);
const deviceReconnectGraceMs = Math.max(30, Number(config.deviceReconnectGraceSeconds || 180)) * 1000;
const notificationRetries = new Set();
const jobEventClients = new Set();

await mkdir(join(rootDir, 'data'), { recursive: true });
await mkdir(artifactDirectory, { recursive: true });
await importLegacyAppleAccounts();

for (const job of state.jobs) {
  if (activeJobStatuses.has(job.status)) {
    if (job.unfairdTaskId) {
      job.status = mapTaskStatus(job.status);
      job.logs = [
        ...(job.logs || []),
        '平台服务重启，已进入恢复模式，继续监控 iPhone 任务。'
      ];
    } else {
      job.status = 'interrupted';
      job.error = '平台服务重启，任务已中断。请重新创建任务。';
    }
    job.updatedAt = new Date().toISOString();
  }
  if (job.status === 'failed' && job.error) {
    const classified = classifyJobError(job.error);
    if (classified.code !== 'job_failed') {
      job.status = classified.status;
      job.error = classified.message;
      job.errorCode = classified.code;
      job.updatedAt = new Date().toISOString();
    }
  }
  if (job.status === 'completed' && job.artifactUrl && !job.artifactExpiresAt) {
    const base = Date.parse(job.completedAt || job.updatedAt || job.createdAt || '');
    job.artifactExpiresAt = new Date((Number.isFinite(base) ? base : Date.now()) + artifactRetentionMilliseconds()).toISOString();
  }
  if (job.status === 'completed' && job.artifactPath && !job.artifactFileName) {
    job.artifactFileName = basename(job.artifactPath);
  }
}
await saveState();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/') && !validateMutationOrigin(req, {
      allowedOrigins: [process.env.PUBLIC_BASE_URL, config.publicBaseUrl].filter(Boolean)
    })) throw Object.assign(new Error('request origin is not allowed'), { status: 403 });
    applyPublicRateLimit(req, url, res);
    if (url.pathname.startsWith('/api/')) {
      if (await adminSystem.handle(req, res, url)) return;
      await routeApi(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/internal/files/')) {
      await serveInternalFile(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/files/')) {
      await serveArtifact(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    json(res, error.status || 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(serverPort, () => {
  console.log(`Private platform listening on http://127.0.0.1:${serverPort}`);
  resumeRecoverableJobs();
  adminSystem.startMonitor();
  scheduleQueuedJobs();
  cleanupExpiredArtifacts().catch(console.error);
  scheduleDatabaseBackup().catch(console.error);
});

setInterval(() => {
  cleanupExpiredArtifacts().catch(console.error);
}, 60 * 1000).unref?.();

setInterval(() => {
  scheduleQueuedJobs();
}, 3_000).unref?.();

setInterval(() => {
  scheduleDatabaseBackup().catch(console.error);
}, 24 * 60 * 60 * 1000).unref?.();

async function scheduleDatabaseBackup() {
  const result = await backupManager.create({ label: 'automatic' });
  console.log(`[backup] verified database backup: ${result.directory}`);
}

setInterval(() => {
  retryFailedNotifications().catch(console.error);
}, 60_000).unref?.();

async function routeApi(req, res, url) {
  if (url.pathname === '/api/health/live') {
    json(res, 200, await health.live());
    return;
  }
  if (url.pathname === '/api/health/ready') {
    const result = await health.ready();
    json(res, result.ok ? 200 : 503, result);
    return;
  }
  if (url.pathname === '/api/metrics') {
    requireAdmin(req, url);
    const jobs = countJobs();
    metrics.gauge('platform_jobs_queued', jobs.queued);
    metrics.gauge('platform_jobs_active', jobs.active);
    const devices = adminSystem.publicDevices();
    metrics.gauge('platform_devices_online', devices.filter((device) => device.online).length);
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(metrics.render());
    return;
  }
  if (url.pathname === '/api/health') {
    json(res, 200, { ok: true, devices: adminSystem.publicDevices().length, jobs: state.jobs.length });
    return;
  }
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const actor = getActor(req, url);
    const user = actor.type === 'wechat' ? publicUser(actor.openid) : null;
    json(res, 200, {
      authenticated: actor.authenticated,
      type: actor.type,
      user,
      balance: user?.balance ?? null,
      isAdmin: actor.isAdmin,
      wechat: {
        enabled: isWechatGatewayConfigured() || isWechatConfigured(),
        mode: isWechatGatewayConfigured() ? 'gateway' : isWechatConfigured() ? 'direct' : 'off',
        appId: wechatGatewayConfig().appId || wechatConfig().appId || ''
      }
    });
    return;
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const actor = getActor(req, url);
    if (actor.type === 'wechat' && actor.sessionTokenHash) {
      state.webSessions = (state.webSessions || []).filter((session) => session.tokenHash !== actor.sessionTokenHash);
      await saveState();
    }
    setSessionCookie(req, res, '', 0);
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/wechat/notification/status' && req.method === 'GET') {
    const actor = requireActor(req, url);
    if (actor.type !== 'wechat') {
      json(res, 200, { available: true, needsRefresh: false, reason: null });
      return;
    }
    json(res, 200, notificationStatusFor(actor.openid));
    return;
  }
  if (url.pathname === '/api/wechat/notification/refresh' && req.method === 'POST') {
    const actor = requireActor(req, url);
    if (actor.type !== 'wechat') {
      json(res, 403, { error: '仅微信公众号登录用户可刷新通知授权' });
      return;
    }
    if (!isWechatGatewayConfigured()) {
      json(res, 501, { error: '微信公众号通知网关未配置' });
      return;
    }
    const body = await readJsonBody(req);
    const browserNonce = String(body.browserNonce || '').trim();
    if (!browserNonce) {
      json(res, 400, { error: 'browserNonce is required' });
      return;
    }
    const session = await wechatGatewayClient().createLoginSession(browserNonce, 300);
    json(res, 201, { ...session, purpose: 'notification_refresh' });
    return;
  }
  if (url.pathname === '/api/wechat/notification/refresh-status' && req.method === 'GET') {
    const actor = requireActor(req, url);
    if (actor.type !== 'wechat') {
      json(res, 403, { error: '仅微信公众号登录用户可刷新通知授权' });
      return;
    }
    const sessionId = url.searchParams.get('sessionId') || '';
    const browserNonce = url.searchParams.get('browserNonce') || '';
    const remote = await wechatGatewayClient().loginStatus(sessionId);
    if (!browserNonce || remote.browserNonce !== browserNonce) {
      json(res, 403, { error: 'notification session browser binding mismatch' });
      return;
    }
    if (remote.status === 'confirmed' && remote.openId) {
      if (remote.openId !== actor.rawOpenId || (actor.appId && remote.appId !== actor.appId)) {
        json(res, 403, { error: '请使用当前登录账号对应的微信完成通知授权' });
        return;
      }
      refreshNotificationWindow(actor.openid);
      await saveState();
      json(res, 200, { status: 'confirmed', notification: notificationStatusFor(actor.openid) });
      return;
    }
    json(res, 200, { status: remote.status, expiresAt: remote.expiresAt });
    return;
  }
  if (url.pathname === '/api/cards/redeem' && req.method === 'POST') {
    const actor = requireActor(req, url);
    const body = await readJsonBody(req);
    const openid = actor.type === 'wechat'
      ? actor.openid
      : actor.isAdmin ? String(body.openid || '').trim() : '';
    if (!openid) {
      const error = new Error('请先使用微信公众号登录后再兑换服务码');
      error.status = 401;
      throw error;
    }
    json(res, 200, adminSystem.store.redeemCard(body.code, openid));
    return;
  }
  if (url.pathname === '/api/integrations/wechat/events' && req.method === 'POST') {
    await handleGatewayEvent(req, res, url);
    return;
  }
  if (url.pathname === '/api/wechat/login/qrcode' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const browserNonce = String(body.browserNonce || '').trim();
    if (!browserNonce) {
      json(res, 400, { error: 'browserNonce is required' });
      return;
    }
    const session = await createWechatLoginSession(browserNonce);
    json(res, 201, session);
    return;
  }
  if (url.pathname === '/api/wechat/login/status' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    const browserNonce = url.searchParams.get('browserNonce') || '';
    if (isWechatGatewayConfigured()) {
      const remote = await wechatGatewayClient().loginStatus(sessionId);
      if (!browserNonce || remote.browserNonce !== browserNonce) {
        json(res, 403, { error: 'login session browser binding mismatch' });
        return;
      }
      if (remote.status === 'confirmed' && remote.openId) {
        const identity = upsertGatewayUser({
          appId: remote.appId,
          openId: remote.openId,
          unionId: remote.unionId,
          subscribed: remote.subscribed !== false,
          eventId: `login:${remote.sessionId}`
        });
        const webSession = createWebSession(identity.userKey, {
          appId: identity.appid,
          openId: identity.openid
        });
        refreshNotificationWindow(identity.userKey);
        await saveState();
        setSessionCookie(req, res, webSession.token, webSession.maxAgeSeconds);
        json(res, 200, {
          status: 'confirmed',
          user: publicUser(identity.userKey),
          expiresAt: webSession.expiresAt
        });
        return;
      }
      json(res, 200, { status: remote.status, expiresAt: remote.expiresAt });
      return;
    }
    const session = (state.loginSessions || []).find((item) => item.sessionId === sessionId);
    if (!session) {
      json(res, 404, { error: 'login session not found' });
      return;
    }
    if (!browserNonce || session.browserNonce !== browserNonce) {
      json(res, 403, { error: 'login session browser binding mismatch' });
      return;
    }
    if (Date.parse(session.expiresAt || '') <= Date.now() && session.status === 'pending') {
      session.status = 'expired';
      await saveState();
    }
    if (session.status === 'confirmed' && session.openid) {
      const webSession = createWebSession(session.openid);
      session.status = 'consumed';
      await saveState();
      setSessionCookie(req, res, webSession.token, webSession.maxAgeSeconds);
      json(res, 200, {
        status: 'confirmed',
        user: publicUser(session.openid),
        expiresAt: webSession.expiresAt
      });
      return;
    }
    json(res, 200, { status: session.status, expiresAt: session.expiresAt });
    return;
  }
  if (url.pathname === '/api/wechat/callback' && req.method === 'GET') {
    handleWechatCallbackVerify(req, res, url);
    return;
  }
  if (url.pathname === '/api/wechat/callback' && req.method === 'POST') {
    await handleWechatEvent(req, res, url);
    return;
  }
  if (url.pathname === '/api/platform') {
    const cardSettings = adminSystem.store.getSetting('cards', config.cards || {}) || {};
    json(res, 200, {
      browserAccountSync: {
        enabled: config.browserAccountSync?.enabled !== false,
        reason: config.browserAccountSync?.reason || ''
      },
      wechat: {
        enabled: isWechatGatewayConfigured() || isWechatConfigured(),
        mode: isWechatGatewayConfigured() ? 'gateway' : isWechatConfigured() ? 'direct' : 'off',
        callbackPath: isWechatGatewayConfigured() ? null : '/api/wechat/callback',
        notifyEnabled: isWechatGatewayConfigured() || Boolean(wechatConfig().templateId)
      },
      cards: {
        purchaseUrl: String(cardSettings.purchaseUrl || ''),
        purchaseHint: String(cardSettings.purchaseHint || '请在微信公众号回复“购买兑换码”获取购买方式')
      }
    });
    return;
  }
  if (url.pathname === '/api/apps') {
    json(res, 200, apps);
    return;
  }
  if (url.pathname === '/api/top-apps' && req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId');
    const country = url.searchParams.get('country') || 'cn';
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 24)));
    json(res, 200, await loadTopApps(deviceId, country, limit));
    return;
  }
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId');
    const term = url.searchParams.get('term') || '';
    const country = url.searchParams.get('country') || 'cn';
    const storefront = normalizeStorefront(country, 'cn');
    const entity = url.searchParams.get('entity') || 'software';
    const limit = url.searchParams.get('limit') || '25';
    if (!term.trim()) {
      json(res, 200, []);
      return;
    }
    const params = new URLSearchParams({ term, country, entity, limit });
    const result = await devicePool.run(
      (device) => unfairdGet(device, `/api/search?${params}`),
      { deviceId }
    );
    json(res, 200, Array.isArray(result)
      ? result.map((item) => ({ ...item, country, storefront }))
      : result);
    return;
  }
  if (url.pathname === '/api/lookup' && req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId');
    const country = url.searchParams.get('country') || 'cn';
    const storefront = normalizeStorefront(country, 'cn');
    const appId = url.searchParams.get('id');
    const bundleId = url.searchParams.get('bundleId');
    if (!appId && !bundleId) {
      json(res, 400, { error: 'missing id or bundleId' });
      return;
    }
    const params = new URLSearchParams({ country });
    params.set(appId ? 'id' : 'bundleId', appId || bundleId);
    const result = await devicePool.run(
      (device) => unfairdGet(device, `/api/lookup?${params}`),
      { deviceId }
    );
    json(res, 200, result && typeof result === 'object' ? { ...result, country, storefront } : result);
    return;
  }
  if (url.pathname === '/api/apple/default/versions' && req.method === 'POST') {
    requireActor(req, url);
    const body = await readJsonBody(req);
    const software = normalizeSoftware(body.software);
    if (!software) {
      json(res, 400, { error: 'missing or invalid software' });
      return;
    }
    const storefront = storefrontFromBody(body, software);
    const provider = normalizeVersionProvider(body.provider);
    if (provider !== 'apple' && software.id) {
      const catalog = await fetchHistoricalVersions(software.id, provider);
      if (catalog.versions.length || provider !== 'auto') {
        json(res, 200, {
          versions: catalog.versions.map((record) => record.versionId),
          records: catalog.versions,
          provider: catalog.provider,
          errors: catalog.errors
        });
        return;
      }
    }
    const result = await devicePool.run(
      (device) => withAppleAccountLease({
        store: adminSystem.store,
        device,
        purpose: 'history-versions',
        storefront,
        operation: (account) => unfairdPost(device, '/api/apple/versions', { account, software })
      }),
      { deviceId: body.deviceId }
    );
    json(res, 200, {
      versions: Array.isArray(result.versions) ? result.versions : [],
      records: [],
      provider: 'apple',
      account: publicAccountInfo(result.account)
    });
    return;
  }
  if (url.pathname === '/api/apple/default/version-metadata' && req.method === 'POST') {
    requireActor(req, url);
    const body = await readJsonBody(req);
    const software = normalizeSoftware(body.software);
    const versionId = String(body.versionId || '').trim();
    if (!software || !versionId) {
      json(res, 400, { error: 'missing software or versionId' });
      return;
    }
    const storefront = storefrontFromBody(body, software);
    const result = await devicePool.run(
      (device) => withAppleAccountLease({
        store: adminSystem.store,
        device,
        purpose: 'history-metadata',
        storefront,
        operation: (account) => unfairdPost(device, '/api/apple/version-metadata', {
          account,
          software,
          versionId
        })
      }),
      { deviceId: body.deviceId }
    );
    json(res, 200, {
      metadata: result.metadata || null,
      account: publicAccountInfo(result.account)
    });
    return;
  }
  if (url.pathname === '/api/apple/default/version-info' && req.method === 'POST') {
    requireActor(req, url);
    const body = await readJsonBody(req);
    const software = normalizeSoftware(body.software);
    const versionId = String(body.versionId || '').trim();
    if (!software || !versionId) {
      json(res, 400, { error: 'missing software or versionId' });
      return;
    }
    const storefront = storefrontFromBody(body, software);
    const cached = getCachedVersionInfo(versionInfoCacheKey(storefront, software, versionId));
    if (cached) {
      json(res, 200, { metadata: cached });
      return;
    }
    const result = await devicePool.run(
      (device) => withAppleAccountLease({
        store: adminSystem.store,
        device,
        purpose: 'history-info',
        storefront,
        operation: async (account) => {
          await unfairdPost(device, '/api/account/default/import', { account });
          return unfairdPost(device, '/api/downloads/apple/default/materials', {
            software,
            externalVersionId: versionId,
            forceExtensionDecryption: false
          });
        }
      }),
      { deviceId: body.deviceId }
    );
    const metadata = versionMetadataFromMaterials(result, software);
    setCachedVersionInfo(versionInfoCacheKey(storefront, software, versionId), metadata);
    json(res, 200, {
      metadata
    });
    return;
  }
  if (url.pathname === '/api/apple/default/version-info-batch' && req.method === 'POST') {
    requireActor(req, url);
    const body = await readJsonBody(req);
    const software = normalizeSoftware(body.software);
    const versionIds = Array.from(new Set((Array.isArray(body.versionIds) ? body.versionIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))).slice(0, 32);
    if (!software || !versionIds.length) {
      json(res, 400, { error: 'missing software or versionIds' });
      return;
    }
    const storefront = storefrontFromBody(body, software);
    const items = [];
    const missing = [];
    for (const versionId of versionIds) {
      const cached = getCachedVersionInfo(versionInfoCacheKey(storefront, software, versionId));
      if (cached) {
        items.push({ versionId, metadata: cached, cached: true });
      } else {
        missing.push(versionId);
      }
    }
    let accountInfo = null;
    if (missing.length) {
      const result = await devicePool.run(
        (device) => withAppleAccountLease({
          store: adminSystem.store,
          device,
          purpose: 'history-info-batch',
          storefront,
          operation: async (account) => {
            await unfairdPost(device, '/api/account/default/import', { account });
            const fetched = await mapWithConcurrency(missing, 4, async (versionId) => {
              try {
                const raw = await unfairdPost(device, '/api/downloads/apple/default/materials', {
                  software,
                  externalVersionId: versionId,
                  forceExtensionDecryption: false
                });
                const metadata = versionMetadataFromMaterials(raw, software);
                setCachedVersionInfo(versionInfoCacheKey(storefront, software, versionId), metadata);
                return { versionId, metadata };
              } catch (error) {
                if (isDeviceUnavailableError(error)) throw error;
                return {
                  versionId,
                  metadata: {
                    displayVersion: '',
                    releaseDate: '',
                    sizeText: '',
                    error: error.message || String(error)
                  }
                };
              }
            });
            return { items: fetched, account };
          }
        }),
        { deviceId: body.deviceId }
      );
      accountInfo = publicAccountInfo(result.account);
      items.push(...(Array.isArray(result.items) ? result.items : []));
    }
    const byVersionId = new Map(items.map((item) => [String(item.versionId), item]));
    json(res, 200, {
      items: versionIds.map((versionId) => byVersionId.get(versionId) || {
        versionId,
        metadata: { displayVersion: '', releaseDate: '', sizeText: '', error: 'metadata unavailable' }
      }),
      account: accountInfo
    });
    return;
  }
  if (url.pathname === '/api/devices') {
    requireActor(req, url);
    json(res, 200, adminSystem.publicDevices().map((device) => ({
      id: device.id,
      name: device.name,
      baseUrl: device.baseUrl,
      online: device.online,
      enabled: device.enabled,
      status: device.online ? 'online' : device.lifecycleState,
      modelName: device.modelName,
      iosVersion: device.iosVersion,
      groupName: device.groupName
    })));
    return;
  }
  if (url.pathname === '/api/account/sync-browser' && req.method === 'POST') {
    requireAdmin(req, url);
    if (config.browserAccountSync?.enabled === false) {
      json(res, 501, {
        error: config.browserAccountSync?.reason ||
          '当前部署环境不支持浏览器缓存账户态同步。请在 Mac 本机同步后上传 account.current.json，或直接使用已配置的账户文件。'
      });
      return;
    }
    const body = await readJsonBody(req);
    const { account, source } = await devicePool.run(async (device) => {
      const existingAccount = await loadJson(resolvePath(device.accountFile));
      const result = await syncBrowserAccount({ device, existingAccount });
      await persistDeviceAccount(device, result.account);
      return result;
    }, { deviceId: body.deviceId });
    json(res, 200, {
      ok: true,
      source,
      account: publicAccountInfo(account)
    });
    return;
  }
  if (url.pathname === '/api/account/import-to-device' && req.method === 'POST') {
    requireAdmin(req, url);
    const body = await readJsonBody(req);
    const result = await devicePool.run(async (device) => {
      const account = await loadJson(resolvePath(device.accountFile));
      const status = await unfairdPost(device, '/api/account/default/import', { account });
      return { device, status };
    }, { deviceId: body.deviceId });
    json(res, 200, {
      ok: true,
      device: { id: result.device.id, name: result.device.name, baseUrl: result.device.baseUrl },
      account: result.status
    });
    return;
  }
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    const actor = requireActor(req, url);
    const jobs = actor.isAdmin
      ? state.jobs
      : state.jobs.filter((job) => job.openid === actor.openid);
    json(res, 200, enrichJobs(jobs.slice().reverse()));
    return;
  }
  if (url.pathname === '/api/jobs/events' && req.method === 'GET') {
    const actor = requireActor(req, url);
    startJobEventStream(req, res, actor);
    return;
  }
  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    const actor = requireActor(req, url);
    const body = await readJsonBody(req);
    const job = await createJob(body, actor);
    json(res, 201, job);
    scheduleQueuedJobs();
    return;
  }
  const downloadMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const job = state.jobs.find((item) => item.id === downloadMatch[1]);
    if (!job || job.status === 'expired') {
      json(res, job?.status === 'expired' ? 410 : 404, { error: job?.error || 'job not found' });
      return;
    }
    const actor = getActor(req, url);
    const downloadToken = url.searchParams.get('downloadToken') || '';
    const tokenAuthorized = Boolean(job.downloadToken && downloadToken === job.downloadToken);
    if (!tokenAuthorized && !actor.isAdmin && (!actor.authenticated || job.openid !== actor.openid)) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    if (job.remoteStorage?.provider === 'tencent-cos') {
      res.writeHead(302, {
        'Cache-Control': 'no-store',
        Location: cosSignedDownloadUrl(job.remoteStorage.key, job.remoteStorage.configKey || 'cos')
      });
      res.end();
      return;
    }
    if (job.artifactUrl) {
      res.writeHead(302, {
        'Cache-Control': 'no-store',
        Location: withDownloadToken(job.artifactUrl, job.downloadToken)
      });
      res.end();
      return;
    }
    json(res, 404, { error: 'artifact not found' });
    return;
  }
  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (match && req.method === 'GET') {
    const actor = requireActor(req, url);
    const job = state.jobs.find((item) => item.id === match[1]);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    if (!actor.isAdmin && job.openid !== actor.openid) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    json(res, 200, enrichJob(job));
    return;
  }
  json(res, 404, { error: 'not found' });
}

async function createJob(body, actor = { isAdmin: true }) {
  const software = body.software && normalizeSoftware(body.software);
  const app = software ? appFromSoftware(software) : apps.find((item) => item.id === body.appId || item.bundleId === body.bundleId);
  if (!app) throw new Error('app not found');
  const storefront = storefrontFromBody(body, software);
  if (!adminSystem.store.hasEnabledAppleAccount({ storefront })) {
    throw missingStorefrontAccountError(storefront);
  }
  if (software) {
    software.storefront = storefront;
    software.country = software.country || storefront;
  }
  const requestedDeviceId = actor.isAdmin && body.deviceId ? String(body.deviceId) : null;
  const deviceLock = Boolean(actor.isAdmin && body.deviceLock && requestedDeviceId);
  if (requestedDeviceId) selectDevice(requestedDeviceId);
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const openid = actor.type === 'wechat' ? actor.openid : (body.openid || null);
  const admission = admitJob(state.jobs, openid, adminSystem.schedulerSettings());
  if (!admission.admitted) {
    const error = new Error(admission.code === 'global_queue_limit'
      ? '平台任务队列已满，请稍后重试'
      : '当前用户排队任务已达到上限，请等待已有任务完成');
    error.status = 429;
    error.code = admission.code;
    throw error;
  }
  const creditCharged = Boolean(actor.type === 'wechat' && openid);
  if (creditCharged) {
    const user = adminSystem.store.wechatUser(openid);
    if (!user?.subscribed) {
      const error = new Error('当前微信账号未关注公众号，不能创建新任务');
      error.status = 403;
      throw error;
    }
  }
  if (creditCharged) adminSystem.store.consumeCredit(openid, id);
  const job = {
    id,
    app,
    deviceId: null,
    preferredDeviceId: requestedDeviceId,
    deviceLock,
    status: 'queued',
    progress: 0,
    workflowStage: 'queued',
    stageProgress: 0,
    forceExtensionDecryption: body.forceExtensionDecryption === true,
    externalVersionId: body.externalVersionId || null,
    requestedVersion: body.externalVersionId ? String(body.requestedVersion || '').trim() || null : null,
    storefront,
    openid,
    creditCharged,
    logs: ['任务已创建，等待设备执行。', `下载地区：${storefrontLabel(storefront)}。`],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    unfairdTaskId: null,
    software,
    compatibility: {
      status: software?.minimumOsVersion || software?.minimumOSVersion ? 'resolved' : 'unknown',
      minimumOsVersion: software?.minimumOsVersion || software?.minimumOSVersion || ''
    },
    artifactUrl: null,
    notifyStatus: 'pending',
    notifiedAt: null,
    error: null,
    attempts: [],
    excludedDeviceIds: []
  };
  state.jobs.push(job);
  await saveState();
  return job;
}

function storefrontFromBody(body = {}, software = null) {
  return normalizeStorefront(
    body.storefront
      || body.country
      || software?.storefront
      || software?.country
      || 'cn',
    'cn'
  );
}

function missingStorefrontAccountError(storefront) {
  const error = new Error('后台未配置该地区的Apple id账号，无法进行下载操作。');
  error.status = 409;
  return error;
}

async function adminJobAction({ id, action, body }) {
  const job = getJob(id);
  if (action === 'cancel') {
    if (['completed', 'failed', 'expired', 'cancelled'].includes(job.status)) {
      throw Object.assign(new Error('当前任务状态不能取消'), { status: 409 });
    }
    job.cancelRequested = true;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.error = '管理员已取消任务';
      finishCurrentAttempt(job, 'cancelled');
      adminSystem.store.releaseAppleAccount(job.id);
      refundJobCredit(job);
    }
    job.logs.push('管理员请求取消任务。');
    touch(job);
  }
  if (action === 'retry') {
    if (!['failed', 'interrupted', 'needs_verification', 'cancelled'].includes(job.status)) {
      throw Object.assign(new Error('只有失败或已取消任务可以重试'), { status: 409 });
    }
    job.status = 'queued';
    updateWorkflowProgress(job, 'queued', 0, { reset: true });
    job.error = null;
    job.errorCode = null;
    job.cancelRequested = false;
    job.deviceId = null;
    job.unfairdTaskId = null;
    job.excludedDeviceIds = [];
    job.excludedAppleAccountIds = [];
    job.logs.push('管理员已将任务重新加入全局队列。');
    touch(job);
    scheduleQueuedJobs();
  }
  if (action === 'lock') {
    const deviceId = String(body.deviceId || '').trim();
    if (!deviceId) throw Object.assign(new Error('请选择锁定设备'), { status: 400 });
    selectDevice(deviceId);
    job.preferredDeviceId = deviceId;
    job.deviceLock = body.locked !== false;
    job.logs.push(job.deviceLock ? `管理员锁定设备：${deviceId}` : `管理员设置优先设备：${deviceId}`);
    touch(job);
  }
  return enrichJob(job);
}

function scheduleQueuedJobs() {
  const activeDevices = activeDeviceIds();
  const devices = adminSystem.schedulingDevices().filter((device) => device.online);
  const queued = state.jobs.filter((job) => job.status === 'queued');
  const scheduler = adminSystem.schedulerSettings();
  for (const next of fairQueueOrder(queued)) {
    if (!canDispatchJob(next, state.jobs, scheduler)) continue;
    const device = selectCandidateDevice(next, devices, activeDevices);
    if (!device) {
      updateCompatibilityWait(next, devices, activeDevices);
      continue;
    }
    if (!jobJournal.acquireDeviceLease(device.id, next.id)) continue;
    assignJobAttempt(next, device);
    startJob(next.id);
    activeDevices.add(device.id);
  }
}

function startJob(jobId) {
  if (runningJobs.has(jobId)) return;
  runJob(jobId)
    .catch((error) => handleJobFailure(jobId, error))
    .finally(() => scheduleQueuedJobs());
}

function resumeRecoverableJobs() {
  for (const job of state.jobs) {
    if (!activeJobStatuses.has(job.status) || !job.unfairdTaskId) continue;
    resumeDeviceTask(job.id);
  }
}

function resumeDeviceTask(jobId) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  monitorExistingDeviceTask(jobId)
    .catch((error) => failJob(jobId, error))
    .finally(() => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (job?.deviceId) jobJournal.releaseDeviceLease(job.deviceId, jobId);
      runningJobs.delete(jobId);
      scheduleQueuedJobs();
    });
}

async function monitorExistingDeviceTask(jobId) {
  const job = getJob(jobId);
  const device = selectDevice(job.deviceId);
  job.logs.push(`继续监控 iPhone 任务：${job.unfairdTaskId}`);
  touch(job);

  let task = await getDeviceTaskWithReconnect(device, job, job.unfairdTaskId);
  while (!['completed', 'failed'].includes(task.status)) {
    await delay(2500);
    task = await getDeviceTaskWithReconnect(device, job, job.unfairdTaskId);
    job.status = mapTaskStatus(task.status);
    updateFromDeviceTask(job, task);
    job.speed = task.speed || '';
    job.logs = mergeLogs(job.logs, task.logs || []);
    job.decryptEvents = task.decryptEvents || [];
    touch(job, false);
    await saveState();
  }

  if (task.status === 'failed') {
    throw deviceTaskFailure(task);
  }

  await deleteRouterSourceArtifact(job, { pickupConfirmed: true }).catch((error) => {
    job.logs.push(`清理 iStoreOS 原始 IPA 失败：${error.message || String(error)}`);
  });

  job.status = 'uploading';
  updateWorkflowProgress(job, 'retrieving', 0);
  job.speed = '';
  job.logs.push('iPhone 已完成砸壳，恢复流程开始拉取 IPA。');
  touch(job);

  const file = await downloadPackage(device, task, job);
  const artifact = await publishArtifact(file, job);
  job.status = 'completed';
  updateWorkflowProgress(job, 'completed', 100);
  job.speed = '';
  job.artifactUrl = artifact.url;
  job.artifactPath = artifact.path;
  job.artifactFileName = artifactFileName(artifact);
  job.downloadToken = randomId(24);
  job.completedAt = new Date().toISOString();
  job.artifactExpiresAt = new Date(Date.now() + artifactRetentionMilliseconds()).toISOString();
  job.error = null;
  job.errorCode = null;
  job.logs.push(`输出完成：${artifact.url}`);
  touch(job);
  await notifyJobFinished(job, 'completed').catch((error) => {
    recordNotificationFailure(job, error);
  });
}

function activeDeviceIds() {
  const active = jobJournal.activeDeviceIds();
  for (const jobId of runningJobs) {
    const job = state.jobs.find((item) => item.id === jobId);
    if (job?.deviceId) active.add(job.deviceId);
  }
  return active;
}

function selectCandidateDevice(job, devices, activeDevices) {
  const excluded = new Set(job.excludedDeviceIds || []);
  const lockedId = job.deviceLock ? job.preferredDeviceId : null;
  const compatible = devices.filter((device) => {
    if (activeDevices.has(device.id) || excluded.has(device.id)) return false;
    if (lockedId && device.id !== lockedId) return false;
    if (!lockedId && device.priorityClass === 'test') return false;
    if (!deviceCanRunJob(device, job)) return false;
    return attemptsForDevice(job, device.id)
      < Math.max(1, Number(adminSystem.effectiveDeviceConfig(device).maxAttemptsPerDevice || 2));
  });
  compatible.sort((a, b) => {
    if (job.preferredDeviceId) {
      if (a.id === job.preferredDeviceId && b.id !== job.preferredDeviceId) return -1;
      if (b.id === job.preferredDeviceId && a.id !== job.preferredDeviceId) return 1;
    }
    const priority = devicePriority(a) - devicePriority(b);
    if (priority !== 0) return priority;
    if (Number(b.weight || 0) !== Number(a.weight || 0)) return Number(b.weight || 0) - Number(a.weight || 0);
    return String(a.id).localeCompare(String(b.id));
  });
  return compatible[0] || null;
}

function deviceCanRunJob(device, job) {
  const effective = adminSystem.effectiveDeviceConfig(device);
  return evaluateDeviceScheduling(device, job, effective).eligible === true;
}

function updateCompatibilityWait(job, devices, activeDevices) {
  const minimumOsVersion = String(
    job.software?.minimumOsVersion || job.software?.minimumOSVersion || ''
  ).trim();
  const candidates = devices
    .filter((device) => !activeDevices.has(device.id))
    .map((device) => ({
      id: device.id,
      name: device.name,
      iosVersion: device.iosVersion || '',
      ...evaluateDeviceScheduling(device, job, adminSystem.effectiveDeviceConfig(device))
    }));
  const compatible = candidates.filter((device) => device.eligible);
  const next = {
    status: compatible.length ? 'waiting_for_device' : 'waiting_for_compatible_device',
    minimumOsVersion,
    compatibleDeviceIds: compatible.map((device) => device.id),
    rejectedDevices: candidates
      .filter((device) => !device.eligible)
      .map((device) => ({
        id: device.id,
        name: device.name,
        iosVersion: device.iosVersion,
        reason: device.code,
        requiredBytes: device.requiredBytes || null,
        availableBytes: device.availableBytes || null
      }))
  };
  if (JSON.stringify(job.compatibility) === JSON.stringify(next)) return;
  job.compatibility = next;
  if (!compatible.length) {
    const storageRejected = candidates.filter((device) => device.code === 'insufficient_storage');
    if (storageRejected.length) {
      const summary = storageRejected.map((device) =>
        `${device.name} 需要 ${formatBytes(device.requiredBytes)}，可用 ${formatBytes(device.availableBytes)}`
      ).join('；');
      job.logs.push(`等待空间充足的设备：${summary}。`);
    } else if (minimumOsVersion) {
      job.logs.push(`等待兼容设备：应用最低要求 iOS ${minimumOsVersion}，当前没有已确认兼容且空闲的设备。`);
    } else {
      job.logs.push('等待满足砸壳能力要求的空闲设备。');
    }
  }
  touch(job);
}

function devicePriority(device) {
  return {
    primary: 1,
    normal: 2,
    standby: 3,
    test: 4
  }[device.priorityClass] || 3;
}

function assignJobAttempt(job, device) {
  const now = new Date().toISOString();
  job.deviceId = device.id;
  job.assignedAt = now;
  job.attempts = Array.isArray(job.attempts) ? job.attempts : [];
  job.attempts.push({
    id: randomId(8),
    number: job.attempts.length + 1,
    deviceId: device.id,
    deviceName: device.name,
    status: 'running',
    startedAt: now,
    completedAt: null,
    errorCode: null,
    error: null
  });
  job.logs = Array.isArray(job.logs) ? job.logs : [];
  const compatibility = evaluateDeviceCompatibility(device, job);
  job.compatibility = {
    status: 'assigned',
    minimumOsVersion: compatibility.minimumOsVersion,
    selectedDeviceId: device.id,
    selectedDeviceIosVersion: compatibility.deviceIosVersion
  };
  if (compatibility.minimumOsVersion) {
    job.logs.push(`兼容性检查通过：应用最低 iOS ${compatibility.minimumOsVersion}，设备为 iOS ${compatibility.deviceIosVersion}。`);
  }
  job.logs.push(`调度器选择设备：${device.name}（${device.priorityClass}，权重 ${device.weight}）。`);
  touch(job);
}

function finishCurrentAttempt(job, status, classified = null) {
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];
  const current = [...attempts].reverse().find((attempt) => attempt.status === 'running');
  if (!current) return;
  current.status = status;
  current.completedAt = new Date().toISOString();
  current.errorCode = classified?.code || null;
  current.error = classified?.message || null;
}

function attemptsForDevice(job, deviceId) {
  if (!deviceId) return 0;
  return (job.attempts || []).filter((attempt) => attempt.deviceId === deviceId).length;
}

function canRetryJob(job, classified) {
  if (!classified.retryable) return false;
  const scheduler = adminSystem.schedulerSettings();
  const currentDevice = job.deviceId
    ? adminSystem.publicDevices().find((device) => device.id === job.deviceId)
    : null;
  const effective = currentDevice ? adminSystem.effectiveDeviceConfig(currentDevice) : scheduler;
  const perDeviceLimit = Math.max(1, Number(effective.maxAttemptsPerDevice || scheduler.maxAttemptsPerDevice || 2));
  const maxAttempts = Math.max(1, Number(scheduler.maxAttemptsPerJob || 5));
  const maxDevices = Math.max(1, Number(scheduler.maxDevicesPerJob || 3));
  const attempts = job.attempts || [];
  if (attempts.length >= maxAttempts) return false;
  const attemptedDevices = new Set(attempts.map((attempt) => attempt.deviceId).filter(Boolean));
  if (['same-device', 'next-account'].includes(classified.retryScope)
    && attemptsForDevice(job, job.deviceId) < perDeviceLimit) {
    if (classified.retryScope !== 'next-account') return true;
    const accounts = adminSystem.store.listAppleAccounts();
    const excludedAccounts = new Set(job.excludedAppleAccountIds || []);
    if (job.appleAccountId) excludedAccounts.add(job.appleAccountId);
    const requestedStorefront = job.storefront ? normalizeStorefront(job.storefront, '') : '';
    return accounts.some((account) =>
      account.enabled
      && !account.lease
      && !excludedAccounts.has(account.id)
      && (!requestedStorefront || account.storefront === requestedStorefront)
    );
  }
  if (job.deviceLock) return false;
  if (attemptedDevices.size >= maxDevices) return false;
  const candidates = adminSystem.schedulingDevices().filter((device) =>
    device.online &&
    device.priorityClass !== 'test' &&
    !new Set(job.excludedDeviceIds || []).has(device.id) &&
    attemptsForDevice(job, device.id) < Math.max(
      1,
      Number(adminSystem.effectiveDeviceConfig(device).maxAttemptsPerDevice || perDeviceLimit)
    ) &&
    deviceCanRunJob(device, job)
  );
  return candidates.some((device) => device.id !== job.deviceId);
}

function retrySummary(job) {
  const scheduler = adminSystem.schedulerSettings();
  const attempts = job.attempts || [];
  return `已尝试 ${attempts.length}/${scheduler.maxAttemptsPerJob} 次，涉及 ${new Set(attempts.map((attempt) => attempt.deviceId)).size}/${scheduler.maxDevicesPerJob} 台设备`;
}

function enrichJobs(jobs) {
  const queueState = buildQueueState();
  return jobs.map((job) => enrichJob(job, queueState));
}

function enrichJob(job, queueState = buildQueueState()) {
  return {
    ...job,
    ...workflowProgressView(job),
    artifactUrl: job.status === 'completed' && (job.artifactUrl || job.remoteStorage)
      ? jobDownloadUrl(job)
      : job.artifactUrl,
    queue: queueInfoForJob(job, queueState)
  };
}

function buildQueueState() {
  const estimatedJobSeconds = estimateJobSeconds();
  const devices = new Map(adminSystem.publicDevices().map((device) => [device.id, device]));
  const activeByDevice = new Map();
  const queued = [];

  for (const job of state.jobs) {
    if (activeJobStatuses.has(job.status)) {
      activeByDevice.set(job.deviceId, (activeByDevice.get(job.deviceId) || 0) + 1);
    }
    if (job.status === 'queued') {
      queued.push(job);
    }
  }

  queued.splice(0, queued.length, ...fairQueueOrder(queued));

  const onlineTotal = state.jobs.filter((job) => job.status === 'queued' || activeJobStatuses.has(job.status)).length;
  const availableDevices = [...devices.values()].filter((device) =>
    device.enabled && device.online && !['maintenance', 'quarantined', 'draining'].includes(device.lifecycleState)
      && device.priorityClass !== 'test'
  ).length;
  return { devices, activeByDevice, queued, estimatedJobSeconds, onlineTotal, availableDevices };
}

function queueInfoForJob(job, queueState) {
  const device = queueState.devices.get(job.deviceId);
  const deviceActive = queueState.activeByDevice.get(job.deviceId) || 0;
  const deviceQueued = job.deviceId
    ? queueState.queued.filter((item) => item.preferredDeviceId === job.deviceId && item.deviceLock).length
    : 0;
  const deviceLineTotal = deviceActive + deviceQueued;
  const base = {
    mode: 'global',
    deviceId: job.deviceId,
    deviceName: device?.name || job.deviceId || '等待动态分配',
    onlineTotal: queueState.onlineTotal,
    deviceLineTotal,
    deviceActive,
    deviceQueued,
    availableDevices: queueState.availableDevices,
    estimatedJobSeconds: queueState.estimatedJobSeconds
  };

  if (job.status === 'queued') {
    const index = queueState.queued.findIndex((item) => item.id === job.id);
    const position = index >= 0 ? index + 1 : null;
    const ahead = Math.max(0, index);
    const lanes = Math.max(1, queueState.availableDevices);
    return {
      ...base,
      position,
      ahead,
      estimatedWaitSeconds: Math.ceil(ahead / lanes) * queueState.estimatedJobSeconds
    };
  }

  if (activeJobStatuses.has(job.status)) {
    return {
      ...base,
      position: 0,
      ahead: 0,
      estimatedWaitSeconds: 0
    };
  }

  return base;
}

function estimateJobSeconds() {
  const durations = state.jobs
    .filter((job) => job.status === 'completed' && job.createdAt && job.updatedAt)
    .slice(-20)
    .map((job) => Math.round((new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime()) / 1000))
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 30 && seconds <= 7200)
    .sort((a, b) => a - b);
  if (!durations.length) return 600;
  return durations[Math.floor(durations.length / 2)];
}

async function runJob(jobId) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  let routerStorageReservation = null;
  try {
    const job = getJob(jobId);
    if (!job.deviceId) throw new Error('调度器尚未分配设备');
    ensureJobNotCancelled(job);
    const device = selectDevice(job.deviceId);
    const effectiveDeviceConfig = adminSystem.effectiveDeviceConfig(device);
    const forceExtensionDecryption = job.forceExtensionDecryption === undefined
      ? !Boolean(effectiveDeviceConfig.skipExtensions)
      : Boolean(job.forceExtensionDecryption);
    job.status = 'running';
    updateWorkflowProgress(job, 'preparing', 0);
    job.speed = '';
    job.logs.push(`已分配到设备：${device.name}`);
    touch(job);

    const accountStatus = await ensureDeviceDefaultAccount(device, job);
    ensureJobNotCancelled(job);
    job.accountHash = accountStatus.accountHash || job.accountHash || null;
    updateWorkflowProgress(job, 'preparing', 35);
    job.logs.push(`已确认 ${storefrontLabel(job.storefront)} Apple ID：${accountStatus.emailMasked || '已配置账户'}`);
    touch(job);

    const software = job.software || await unfairdGet(device, `/api/lookup?bundleId=${encodeURIComponent(job.app.bundleId)}`);
    if (!software || !software.id) throw new Error('设备未查询到 App 信息');
    job.software = software;
    updateWorkflowProgress(job, 'preparing', 60);
    job.logs.push(`已查询 App Store 信息：${software.name} ${software.version}`);
    touch(job);

    job.logs.push(`使用 ${storefrontLabel(job.storefront)} Apple ID 获取 App Store 下载材料。`);
    touch(job);
    const rawMaterials = await unfairdPost(device, '/api/downloads/apple/default/materials', {
      software,
      externalVersionId: job.externalVersionId,
      forceExtensionDecryption
    });
    const materials = normalizeAppleDownloadMaterials(rawMaterials, software);
    job.accountHash = materials.accountHash || job.accountHash || null;
    job.software = materials.software || software;
    updateWorkflowProgress(job, 'preparing', 100);
    job.logs.push('已获取 Apple CDN 下载地址、SINF 和 iTunesMetadata。');
    if (materials.software?.softwareVersionExternalIdentifier) {
      job.logs.push(`Apple 外部版本 ID：${materials.software.softwareVersionExternalIdentifier}`);
    }
    touch(job);

    routerStorageReservation = await storageLifecycle.reserve({
      artifactBytes: Number(materials.software?.fileSizeBytes || software.fileSizeBytes || 0),
      workingCopies: 2
    });

    job.status = 'downloading';
    updateWorkflowProgress(job, 'router_download', 0);
    job.logs.push('iStoreOS 开始从 App Store/CDN 下载原始 IPA。');
    touch(job);
    const routerIpa = await downloadAppleIpaToRouter(materials, job);
    ensureJobNotCancelled(job);
    job.routerSourcePath = routerIpa.path;
    job.routerSourceFileName = basename(routerIpa.path);
    job.routerSourceToken = routerIpa.token;
    updateWorkflowProgress(job, 'router_download', 100);
    job.speed = '';
    materials.software = {
      ...(materials.software || software),
      fileSizeBytes: String(routerIpa.fileSize || materials.software?.fileSizeBytes || software.fileSizeBytes || '')
    };
    job.software = materials.software;
    job.logs.push(`iStoreOS 原始 IPA 下载完成：${routerIpa.fileSize ? formatBytes(routerIpa.fileSize) : '已保存'}`);
    touch(job);

    const sourceURL = internalFileUrl(routerIpa.path, routerIpa.token);
    job.logs.push('已生成 iPhone 内网取件链接，开始通知 iPhone 解密。');
    updateWorkflowProgress(job, 'device_transfer', 0);
    touch(job);
    const created = await unfairdPost(device, '/api/downloads/external-url', {
      software: materials.software || software,
      accountHash: materials.accountHash,
      sourceURL,
      sinfs: materials.sinfs || [],
      iTunesMetadata: materials.iTunesMetadata || null,
      forceExtensionDecryption
    });
    const createdTask = created?.task || created;
    if (!createdTask?.id) {
      throw new Error('iPhone 未返回有效的解密任务 ID');
    }

    job.unfairdTaskId = createdTask.id;
    job.accountHash = createdTask.accountHash || materials.accountHash || null;
    job.status = 'downloading';
    job.logs.push(`iPhone 已创建外部 IPA 解密任务：${createdTask.id}`);
    touch(job);

    let task = createdTask;
    while (!['completed', 'failed'].includes(task.status)) {
      ensureJobNotCancelled(job);
      await delay(2500);
      task = await getDeviceTaskWithReconnect(device, job, createdTask.id);
      job.status = mapTaskStatus(task.status);
      updateFromDeviceTask(job, task);
      job.speed = task.speed || '';
      job.logs = mergeLogs(job.logs, task.logs || []);
      job.decryptEvents = task.decryptEvents || [];
      if (isRouterSourceTransferredToDevice(task)) {
        await deleteRouterSourceArtifact(job, { pickupConfirmed: true }).catch((error) => {
          job.logs.push(`清理 iStoreOS 原始 IPA 失败：${error.message || String(error)}`);
        });
      }
      touch(job, false);
      await saveState();
    }

    if (task.status === 'failed') {
      throw deviceTaskFailure(task);
    }

    await deleteRouterSourceArtifact(job, { pickupConfirmed: true }).catch((error) => {
      job.logs.push(`清理 iStoreOS 原始 IPA 失败：${error.message || String(error)}`);
    });

    job.status = 'uploading';
    updateWorkflowProgress(job, 'retrieving', 0);
    job.speed = '';
    job.logs.push('iPhone 已完成砸壳，开始拉取 IPA。');
    touch(job);

    const file = await downloadPackage(device, task, job);
    const artifact = await publishArtifact(file, job);
    job.status = 'completed';
    updateWorkflowProgress(job, 'completed', 100);
    job.speed = '';
    job.artifactUrl = artifact.url;
    job.artifactPath = artifact.path;
    job.artifactFileName = artifactFileName(artifact);
    job.downloadToken = randomId(24);
    job.completedAt = new Date().toISOString();
    job.artifactExpiresAt = new Date(Date.now() + artifactRetentionMilliseconds()).toISOString();
    job.logs.push(`输出完成：${artifact.url}`);
    job.logs.push(`下载链接将在 ${formatRetentionMinutes()} 分钟后过期，过期后会自动清理设备内 IPA。`);
    finishCurrentAttempt(job, 'completed');
    adminSystem.store.releaseAppleAccount(job.id);
    touch(job);
    await notifyJobFinished(job, 'completed').catch((error) => {
      recordNotificationFailure(job, error);
    });
  } finally {
    routerStorageReservation?.release();
    const job = state.jobs.find((item) => item.id === jobId);
    if (job?.deviceId) jobJournal.releaseDeviceLease(job.deviceId, jobId);
    runningJobs.delete(jobId);
  }
}

function ensureJobNotCancelled(job) {
  if (!job.cancelRequested) return;
  const error = new Error('管理员已取消任务');
  error.code = 'JOB_CANCELLED';
  throw error;
}

async function cleanupExpiredArtifacts() {
  const now = Date.now();
  let changed = false;
  for (const job of state.jobs) {
    if (!shouldExpireArtifact(job, now)) continue;
    await expireArtifact(job);
    changed = true;
  }
  if (changed) await saveState();
}

function shouldExpireArtifact(job, now) {
  if (job.status !== 'completed') return false;
  if (!job.artifactUrl && !job.artifactPath && !job.unfairdTaskId) return false;
  const expiresAt = Date.parse(job.artifactExpiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

async function expireArtifact(job) {
  const failures = [];
  const device = job.deviceId
    ? adminSystem.store.device(job.deviceId, { includeSecrets: true })
    : null;
  if (device) {
    await deleteDevicePackage(device, job).catch((error) => {
      job.logs.push(`设备 IPA 清理失败：${error.message || String(error)}`);
      failures.push({ provider: 'device', message: error.message || String(error) });
    });
  } else if (job.unfairdTaskId) {
    job.logs.push('原执行设备不存在，已跳过设备端 IPA 清理。');
  }
  await deleteLocalArtifact(job).catch((error) => {
    job.logs.push(`本地 IPA 清理失败：${error.message || String(error)}`);
    failures.push({ provider: 'local', message: error.message || String(error) });
  });
  await deleteRemoteArtifact(job).catch((error) => {
    job.logs.push(`COS IPA 清理失败：${error.message || String(error)}`);
    failures.push({ provider: 'cos', message: error.message || String(error) });
  });
  if (failures.length) {
    job.cleanupPending = { retryable: true, failures, lastAttemptAt: new Date().toISOString() };
    job.logs.push('产物清理未完全成功，已保留引用并将在下一轮自动重试。');
    touch(job, false);
    return;
  }
  job.status = 'expired';
  job.error = '下载链接已过期，请重新创建解密任务。';
  job.errorCode = 'artifact_expired';
  job.artifactUrl = null;
  job.artifactPath = null;
  job.downloadToken = null;
  job.cleanupPending = null;
  job.expiredAt = new Date().toISOString();
  job.logs.push('下载链接已过期，已清理 IPA 文件；如需下载请重新砸壳。');
  touch(job, false);
}

async function deleteRemoteArtifact(job) {
  if (job.remoteStorage?.provider !== 'tencent-cos' || !job.remoteStorage?.key) return;
  await deleteTencentCosObject(job.remoteStorage.key, job.remoteStorage.configKey || 'cos');
  job.logs.push('COS 文件已过期并删除。');
  job.remoteStorage = null;
}

async function deleteDevicePackage(device, job) {
  if (!job.unfairdTaskId) return;
  const url = `${device.baseUrl}/api/packages/${encodeURIComponent(job.unfairdTaskId)}?accountHash=${encodeURIComponent(accountHashForJob(job, device))}`;
  const headers = deviceAccessHeaders(device);
  try {
    const response = await fetch(url, { method: 'DELETE', headers });
    if (!response.ok && response.status !== 404) {
      throw new Error(`设备删除 IPA 失败：${response.status} ${await response.text()}`);
    }
  } catch (error) {
    await runCurlIfAvailable(['-sS', '-X', 'DELETE', ...curlDeviceHeaders(device), url], error);
  }
}

async function deleteLocalArtifact(job) {
  if (!job.artifactPath) return;
  const artifactPath = resolve(job.artifactPath);
  const artifactBase = resolvePath(storageConfig().localDir || './data/artifacts');
  if (!artifactPath.startsWith(artifactBase + '/')) {
    throw new Error(`拒绝清理非 artifacts 目录文件：${artifactPath}`);
  }
  try {
    await unlink(artifactPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function deleteRouterSourceArtifact(job, { pickupConfirmed = false } = {}) {
  if (!job.routerSourcePath) return;
  const sourcePath = resolve(job.routerSourcePath);
  const artifactBase = resolvePath(storageConfig().localDir || './data/artifacts');
  if (!sourcePath.startsWith(artifactBase + '/')) {
    throw new Error(`拒绝清理非 artifacts 目录文件：${sourcePath}`);
  }
  try {
    await unlink(sourcePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  job.logs.push(
    pickupConfirmed
      ? 'iPhone 已完成原始 IPA 取件，已删除 iStoreOS 原始加密 IPA。'
      : '任务未完成，已清理 iStoreOS 原始加密 IPA。'
  );
  job.routerSourcePath = null;
  job.routerSourceFileName = null;
  job.routerSourceToken = null;
}

function isRouterSourceTransferredToDevice(task) {
  return ['injecting', 'decrypting', 'completed'].includes(task?.status);
}

async function downloadAppleIpaToRouter(materials, job) {
  if (!materials?.downloadURL) {
    throw new Error(`iPhone 未返回 Apple CDN 下载地址；下载材料结构：${describeDownloadMaterialsShape(materials)}`);
  }
  const outputDir = resolvePath(storageConfig().localDir || './data/artifacts');
  await mkdir(outputDir, { recursive: true });
  const version = materials.software?.version || job.software?.version || 'latest';
  const safeName = sanitizeFilename(`${job.app.name}_${version}_${job.id}.encrypted.ipa`);
  const outputPath = join(outputDir, safeName);

  try {
    const response = await fetch(materials.downloadURL, {
      redirect: 'follow',
      headers: { 'User-Agent': 'itunesstored/1.0' }
    });
    if (!response.ok || !response.body) {
      throw new Error(`App Store 下载失败：${response.status} ${await response.text()}`);
    }
    const totalBytes = Number(response.headers.get('content-length'))
      || Number(materials.software?.fileSizeBytes || job.software?.fileSizeBytes || 0);
    await streamToFile(response.body, outputPath, {
      totalBytes,
      onProgress: createJobTransferReporter(job, 'router_download', totalBytes)
    });
  } catch (error) {
    await runCurlIfAvailable(
      ['-fL', '--max-time', '0', '-A', 'itunesstored/1.0', '-o', outputPath, materials.downloadURL],
      error
    );
  }

  const fileStat = await stat(outputPath);
  return {
    path: outputPath,
    token: randomId(24),
    fileSize: fileStat.size
  };
}

function internalFileUrl(filePath, token) {
  const storage = storageConfig();
  const base = storage.internalBaseUrl || config.internalBaseUrl || config.localBaseUrl || `http://192.168.100.1:${serverPort}`;
  return `${base.replace(/\/$/, '')}/internal/files/${encodeURIComponent(basename(filePath))}?token=${encodeURIComponent(token)}`;
}

async function downloadPackage(device, task, job) {
  const outputDir = resolvePath(storageConfig().localDir || './data/artifacts');
  await mkdir(outputDir, { recursive: true });
  const safeName = sanitizeFilename(`${job.app.name}_${task.software?.version || 'latest'}_${job.id}.ipa`);
  const outputPath = join(outputDir, safeName);
  const url = `${device.baseUrl}/api/packages/${task.id}/file?accountHash=${encodeURIComponent(accountHashForJob(job, device))}`;
  try {
    const response = await fetch(url, { headers: deviceAccessHeaders(device) });
    if (!response.ok || !response.body) {
      throw new Error(`下载 IPA 失败：${response.status} ${await response.text()}`);
    }
    const totalBytes = Number(response.headers.get('content-length')) || 0;
    await streamToFile(response.body, outputPath, {
      totalBytes,
      onProgress: createJobTransferReporter(job, 'retrieving', totalBytes)
    });
  } catch (error) {
    await runCurlIfAvailable(['-fL', '--max-time', '0', ...curlDeviceHeaders(device), '-o', outputPath, url], error);
  }
  updateWorkflowProgress(job, 'retrieving', 100);
  job.speed = '';
  touch(job);
  return outputPath;
}

function accountHashForJob(job, device) {
  const hash = job.accountHash || device.accountHash || '';
  if (!hash) throw new Error('任务缺少账户标识，请先把 Apple ID 账户态导入 iPhone。');
  return hash;
}

async function ensureDeviceDefaultAccount(device, job = null) {
  const storefront = job?.storefront ? normalizeStorefront(job.storefront, 'cn') : null;
  const leased = adminSystem.store.acquireAppleAccount({
    deviceId: device.id,
    jobId: job?.id || `manual-${randomId(8)}`,
    preferredId: job?.appleAccountId || null,
    excludeIds: job?.excludedAppleAccountIds || [],
    storefront
  });
  if (leased?.account) {
    const status = await unfairdPost(device, '/api/account/default/import', { account: leased.account });
    if (job) {
      job.appleAccountId = leased.id;
      job.appleAccountLabel = leased.label;
    }
    return status;
  }
  if (storefront) throw missingStorefrontAccountError(storefront);
  try {
    const status = await unfairdGet(device, '/api/account/default/status');
    if (status?.configured) return status;
  } catch {}
  if (!device.accountFile) {
    throw new Error('iPhone 未配置默认 Apple ID，且平台没有可导入的账号态文件。');
  }
  const account = await loadJson(resolvePath(device.accountFile));
  return unfairdPost(device, '/api/account/default/import', { account });
}

async function importLegacyAppleAccounts() {
  for (const device of config.devices || []) {
    if (!device.accountFile) continue;
    const id = `legacy-${String(device.id || 'default').replace(/[^A-Za-z0-9_.-]/g, '-')}`;
    if (adminSystem.store.appleAccount(id)) continue;
    try {
      const account = await loadJson(resolvePath(device.accountFile));
      adminSystem.store.upsertAppleAccount({
        id,
        label: `默认 Apple ID（${device.name || device.id}）`,
        account,
        storefront: account.storefront || account.storeFront || account.country || account.store || device.storefront || device.country || 'cn',
        accountHash: device.accountHash || account.accountHash || null,
        isGlobalDefault: true,
        priority: 80,
        deviceIds: [device.id]
      });
    } catch (error) {
      console.warn(`[apple-account] 无法迁移 ${device.id || device.accountFile}: ${error.message || String(error)}`);
    }
  }
}

async function publishArtifact(filePath, job) {
  const storage = storageConfig();
  job.status = 'uploading';
  updateWorkflowProgress(job, 'uploading', 0);
  job.speed = '';
  touch(job);
  if (storage.mode === 'cos' || storage.cos?.enabled) {
    const staged = await storageLifecycle.stage({ sourcePath: filePath, artifactId: job.id });
    let key = cosObjectKey(filePath, job, 'cos');
    let upload;
    try {
      upload = await uploadFileToTencentCos(
        staged.path,
        key,
        'cos',
        createJobTransferReporter(job, 'uploading')
      );
    } catch (primaryError) {
      if (!storage.fallbackCos?.enabled) {
        await storageLifecycle.discard(staged);
        throw primaryError;
      }
      job.logs.push(`主 COS 上传失败，切换备用 COS：${primaryError.message || String(primaryError)}`);
      key = cosObjectKey(filePath, job, 'fallbackCos');
      try {
        upload = await uploadFileToTencentCos(
          staged.path,
          key,
          'fallbackCos',
          createJobTransferReporter(job, 'uploading')
        );
      } catch (fallbackError) {
        await storageLifecycle.discard(staged);
        throw fallbackError;
      }
    }
    job.remoteStorage = {
      provider: 'tencent-cos',
      configKey: upload.configKey,
      key,
      url: upload.url,
      size: staged.size,
      sha256: staged.sha256,
      publishedAt: new Date().toISOString()
    };
    job.storageReceipt = job.remoteStorage;
    await saveState();
    await Promise.all([filePath, staged.path].map((path) => unlink(path).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    })));
    job.logs.push('已上传到腾讯云 COS，并删除 iStoreOS 本地成品 IPA。');
    updateWorkflowProgress(job, 'uploading', 100);
    job.speed = '';
    return { url: upload.url, path: null, remote: 'cos', key };
  }

  const command = storage.cosUploadCommand || process.env.COS_UPLOAD_COMMAND || '';
  if (command.trim()) {
    const staged = await storageLifecycle.stage({ sourcePath: filePath, artifactId: job.id });
    const key = `${job.app.bundleId}/${basename(filePath)}`;
    try {
      const url = await runUploadCommand(command, staged.path, key);
      job.remoteStorage = {
        provider: 'custom', key, url, size: staged.size, sha256: staged.sha256,
        publishedAt: new Date().toISOString()
      };
      job.storageReceipt = job.remoteStorage;
      await saveState();
      await storageLifecycle.discard(staged);
      await unlink(filePath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
      return { url, path: null, remote: 'custom', key };
    } catch (error) {
      await storageLifecycle.discard(staged);
      throw error;
    }
  }
  const publicBase = storage.publicBaseUrl || config.publicBaseUrl || `http://127.0.0.1:${serverPort}`;
  const staged = await storageLifecycle.stage({ sourcePath: filePath, artifactId: job.id });
  const receipt = await storageLifecycle.publish(staged, { fileName: basename(filePath) });
  job.storageReceipt = receipt;
  await saveState();
  return { url: `${publicBase}/files/${encodeURIComponent(receipt.fileName)}`, path: receipt.path, receipt };
}

function artifactFileName(artifact) {
  if (artifact?.path) return basename(artifact.path);
  try {
    const pathname = new URL(artifact?.url || 'http://invalid/unknown.ipa').pathname;
    return basename(decodeURIComponent(pathname)) || 'output.ipa';
  } catch {
    return 'output.ipa';
  }
}

function cosObjectKey(filePath, job, configKey = 'cos') {
  const prefix = String(storageConfig()[configKey]?.prefix || 'ipa').replace(/^\/+|\/+$/g, '');
  const bundleId = sanitizeFilename(job.app?.bundleId || 'unknown');
  const filename = basename(filePath);
  return [prefix, bundleId, filename].filter(Boolean).join('/');
}

async function testStorage({ configKey = 'cos' } = {}) {
  if (!['cos', 'fallbackCos'].includes(configKey)) {
    throw Object.assign(new Error('不支持的 COS 配置'), { status: 400 });
  }
  const storage = storageConfig();
  if (configKey === 'fallbackCos' && !storage.fallbackCos?.enabled) {
    throw Object.assign(new Error('备用 COS 尚未启用'), { status: 409 });
  }
  const directory = resolvePath(storage.localDir || './data/artifacts');
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `.cos-test-${randomId(6)}.txt`);
  const key = [
    String(storage[configKey]?.prefix || 'ipa').replace(/^\/+|\/+$/g, ''),
    '_health',
    `${Date.now()}-${randomId(4)}.txt`
  ].filter(Boolean).join('/');
  try {
    await writeFile(filePath, `91iOS Dump storage test ${new Date().toISOString()}\n`, 'utf8');
    const upload = await uploadFileToTencentCos(filePath, key, configKey);
    await deleteTencentCosObject(key, configKey);
    return { ok: true, configKey, url: upload.url, deleted: true };
  } finally {
    await unlink(filePath).catch(() => {});
  }
}

async function uploadFileToTencentCos(filePath, key, configKey = 'cos', onProgress = null) {
  const cos = getTencentCosConfig(configKey);
  const host = `${cos.bucket}.cos.${cos.region}.myqcloud.com`;
  const signedPathname = `/${key}`;
  const requestPathname = `/${encodeCosPath(key)}`;
  const fileStat = await stat(filePath);
  const authorization = cosAuthorization({
    secretId: cos.secretId,
    secretKey: cos.secretKey,
    method: 'PUT',
    pathname: signedPathname,
    headers: { host }
  });

  await requestCosWithOptionalBody({
    method: 'PUT',
    host,
    pathname: requestPathname,
    filePath,
    size: fileStat.size,
    authorization,
    onProgress
  });

  const base = cos.publicDomain || `https://${host}`;
  return { url: `${base}/${encodeCosPath(key)}`, configKey };
}

async function deleteTencentCosObject(key, configKey = 'cos') {
  if (!key) return;
  const cos = getTencentCosConfig(configKey);
  const host = `${cos.bucket}.cos.${cos.region}.myqcloud.com`;
  const signedPathname = `/${key}`;
  const requestPathname = `/${encodeCosPath(key)}`;
  const authorization = cosAuthorization({
    secretId: cos.secretId,
    secretKey: cos.secretKey,
    method: 'DELETE',
    pathname: signedPathname,
    headers: { host }
  });
  await requestCosWithOptionalBody({ method: 'DELETE', host, pathname: requestPathname, authorization });
}

function getTencentCosConfig(configKey = 'cos') {
  const cos = storageConfig()[configKey] || {};
  const environmentPrefix = configKey === 'fallbackCos' ? 'TENCENT_FALLBACK_COS' : 'TENCENT_COS';
  const result = {
    secretId: process.env[`${environmentPrefix}_SECRET_ID`] || cos.secretId,
    secretKey: process.env[`${environmentPrefix}_SECRET_KEY`] || cos.secretKey,
    region: process.env[`${environmentPrefix}_REGION`] || cos.region,
    bucket: process.env[`${environmentPrefix}_BUCKET`] || cos.bucket,
    publicDomain: String(process.env[`${environmentPrefix}_PUBLIC_DOMAIN`] || cos.publicDomain || '').replace(/\/+$/g, ''),
    signedUrlMinutes: Number(cos.signedUrlMinutes || 15)
  };
  if (!result.secretId || !result.secretKey || !result.region || !result.bucket) {
    throw new Error('腾讯云 COS 未配置完整：secretId/secretKey/region/bucket');
  }
  return result;
}

function cosSignedDownloadUrl(key, configKey = 'cos') {
  return buildCosSignedDownloadUrl(getTencentCosConfig(configKey), key);
}

function requestCosWithOptionalBody({
  method,
  host,
  pathname,
  filePath,
  size = 0,
  authorization,
  onProgress = null
}) {
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest({
      method,
      host,
      path: pathname,
      headers: {
        Host: host,
        Authorization: authorization,
        ...(filePath ? {
          'Content-Length': String(size),
          'Content-Type': 'application/octet-stream'
        } : {})
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolvePromise();
        } else if (method === 'DELETE' && res.statusCode === 404) {
          resolvePromise();
        } else {
          reject(new Error(`腾讯云 COS 请求失败：${method} ${pathname} HTTP ${res.statusCode || 0} ${body.trim()}`));
        }
      });
    });
    req.on('error', reject);
    if (filePath) {
      let written = 0;
      const input = createReadStream(filePath);
      input.on('data', (chunk) => {
        written += chunk.length;
        onProgress?.(written, size);
      });
      input.on('error', reject).pipe(req);
    } else {
      req.end();
    }
  });
}

function normalizeVersionProvider(value) {
  const provider = String(value || 'auto').trim().toLowerCase();
  return ['auto', 'timbrd', 'agzy', 'bilin', 'apple'].includes(provider) ? provider : 'auto';
}

function normalizeHistoricalVersionRecord(item, source) {
  if (!item || typeof item !== 'object') return null;
  const versionId = firstString(item.external_identifier, item.versionId, item.version_id, item.id);
  const version = firstString(item.bundle_version, item.version, item.bundleShortVersionString)
    .replace(/\r/g, '\n')
    .split('\n')[0]
    .trim()
    .replace(/^v/i, '');
  const date = firstString(item.created_at, item.createTime, item.updateTime, item.date, item.time);
  const sizeValue = item.size ?? item.fileSize ?? item.fileSizeBytes;
  const sizeText = typeof sizeValue === 'number' ? formatBytes(sizeValue) : firstString(sizeValue);
  if (!versionId || !version) return null;
  if (!/\d/.test(version) || version.length > 64) return null;
  return {
    id: `${source}-${versionId}-${version}`,
    version,
    versionId,
    date,
    size: sizeText,
    sizeText,
    source
  };
}

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function dedupeHistoricalVersions(records) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const key = `${record.versionId}:${record.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

async function fetchJsonWithTimeout(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': '91iOS-Dump-Web/1.0',
      Accept: 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(Number(options.timeoutMs || 12_000))
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchHistoricalProviderVersions(appId, provider) {
  if (provider === 'timbrd') {
    const params = new URLSearchParams({ id: String(appId) });
    const data = await fetchJsonWithTimeout(`https://api.timbrd.com/apple/app-version/index.php?${params}`);
    const items = Array.isArray(data) ? data : [];
    return items.map((item) => normalizeHistoricalVersionRecord(item, 'timbrd')).filter(Boolean).reverse();
  }
  if (provider === 'agzy') {
    const params = new URLSearchParams({ appid: String(appId) });
    const data = await fetchJsonWithTimeout(`https://app.agzy.cn/searchVersion?${params}`);
    const items = Array.isArray(data?.data) ? data.data : [];
    return items.map((item) => normalizeHistoricalVersionRecord(item, 'agzy')).filter(Boolean);
  }
  if (provider === 'bilin') {
    const data = await fetchJsonWithTimeout(`https://apis.bilin.eu.org/history/${encodeURIComponent(appId)}`);
    const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    return items.map((item) => normalizeHistoricalVersionRecord(item, 'bilin')).filter(Boolean);
  }
  return [];
}

async function fetchHistoricalVersions(appId, provider = 'auto') {
  const normalizedProvider = normalizeVersionProvider(provider);
  const providers = normalizedProvider === 'auto' ? ['timbrd', 'agzy', 'bilin'] : [normalizedProvider];
  const cacheKey = `${normalizedProvider}:${appId}`;
  const cached = historicalVersionsCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 30 * 60 * 1000) return cached.value;

  const errors = [];
  for (const name of providers) {
    try {
      const versions = dedupeHistoricalVersions(await fetchHistoricalProviderVersions(appId, name));
      if (versions.length) {
        const value = { appId: String(appId), provider: name, count: versions.length, versions, errors };
        historicalVersionsCache.set(cacheKey, { createdAt: Date.now(), value });
        return value;
      }
      errors.push(`${name}: 没有返回历史版本`);
    } catch (error) {
      errors.push(`${name}: ${error.message || String(error)}`);
    }
  }

  const value = { appId: String(appId), provider: normalizedProvider, count: 0, versions: [], errors };
  historicalVersionsCache.set(cacheKey, { createdAt: Date.now(), value });
  return value;
}

function versionInfoCacheKey(storefront, software, versionId) {
  const appKey = software?.id || software?.bundleID || software?.bundleId || software?.name || 'unknown';
  return `${normalizeStorefront(storefront, 'cn')}:${appKey}:${versionId}`;
}

function getCachedVersionInfo(key) {
  const cached = versionInfoCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > 6 * 60 * 60 * 1000) {
    versionInfoCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedVersionInfo(key, metadata) {
  if (!metadata || typeof metadata !== 'object') return;
  versionInfoCache.set(key, { createdAt: Date.now(), value: metadata });
}

function versionMetadataFromMaterials(raw, fallbackSoftware = {}) {
  const normalized = normalizeAppleDownloadMaterials(raw, fallbackSoftware);
  const software = normalized.software || {};
  const metadata = normalized.metadata || normalized.iTunesMetadata || {};
  const displayVersion = firstString(
    software.version,
    metadata.bundleShortVersionString,
    metadata.CFBundleShortVersionString,
    metadata.version
  ).replace(/^v/i, '');
  const releaseDate = firstString(
    metadata.releaseDate,
    metadata.currentVersionReleaseDate,
    software.releaseDate
  );
  const fileSizeBytes = firstString(
    software.fileSizeBytes,
    metadata.fileSizeBytes,
    metadata.softwareVersionFileSize,
    metadata.size
  );
  const numericSize = Number(fileSizeBytes);
  return {
    displayVersion,
    releaseDate,
    fileSizeBytes,
    sizeText: Number.isFinite(numericSize) && numericSize > 0 ? formatBytes(numericSize) : firstString(software.fileSize, metadata.fileSize)
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));
  return results;
}

async function loadTopApps(deviceId, country, limit) {
  const storefront = normalizeStorefront(country, 'cn');
  const cacheKey = `${country}:${limit}:${deviceId || 'online-pool'}`;
  const cached = topAppsCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) return cached.apps;

  const url = `https://itunes.apple.com/${encodeURIComponent(country)}/rss/topfreeapplications/limit/${limit}/json`;
  let feed;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Apple RSS failed: ${response.status}`);
    feed = await response.json();
  } catch (error) {
    feed = JSON.parse(await runCurlIfAvailable(['-fsS', '--max-time', '10', url], error));
  }

  const entries = (Array.isArray(feed?.feed?.entry) ? feed.feed.entry : []).slice(0, limit);
  const apps = [];
  const canLoadDeviceDetails = deviceId
    ? Boolean(devicePool.configured(deviceId))
    : adminSystem.schedulingDevices().some((device) => device.online === true);
  for (const entry of entries) {
    const id = entry?.id?.attributes?.['im:id'];
    if (!id) continue;
    if (canLoadDeviceDetails) {
      try {
        const software = await devicePool.run(
          (device) => unfairdGet(device, `/api/lookup?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}`),
          { deviceId }
        );
        if (software?.id) {
          apps.push({ ...software, country, storefront, rank: apps.length + 1 });
          continue;
        }
      } catch {}
    }
    apps.push(rssEntryToSoftware(entry, apps.length + 1, country));
  }

  topAppsCache.set(cacheKey, { createdAt: Date.now(), apps });
  return apps;
}

function rssEntryToSoftware(entry, rank, country = 'cn') {
  const storefront = normalizeStorefront(country, 'cn');
  const images = Array.isArray(entry?.['im:image']) ? entry['im:image'] : [];
  const image = images.at(-1)?.label || '';
  const id = Number(entry?.id?.attributes?.['im:id'] || 0);
  return {
    id,
    rank,
    country,
    storefront,
    bundleID: '',
    name: entry?.['im:name']?.label || entry?.title?.label || `App ${id}`,
    version: '',
    price: Number(entry?.['im:price']?.attributes?.amount || 0),
    artistName: entry?.['im:artist']?.label || '',
    sellerName: entry?.['im:artist']?.label || '',
    description: entry?.summary?.label || '',
    averageUserRating: 0,
    userRatingCount: 0,
    artworkUrl: image,
    screenshotUrls: [],
    minimumOsVersion: '',
    fileSizeBytes: null,
    releaseDate: entry?.['im:releaseDate']?.label || '',
    releaseNotes: null,
    formattedPrice: entry?.['im:price']?.label || '',
    primaryGenreName: entry?.category?.attributes?.label || ''
  };
}

function runUploadCommand(command, filePath, key) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [filePath, key], { shell: true, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolvePromise(stdout.trim().split('\n').at(-1));
      } else {
        reject(new Error(`COS 上传命令失败：${stderr || stdout || code}`));
      }
    });
  });
}

async function unfairdGet(device, path) {
  const url = `${device.baseUrl}${path}`;
  let response;
  try {
    response = await fetch(url, { headers: deviceAccessHeaders(device), signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw deviceUnavailableError(error, device, path);
  }
  if (!response.ok) {
    const error = new Error(`unfaird GET ${path} failed: ${response.status} ${await response.text()}`);
    if (isUnavailableDeviceHttpStatus(response.status)) {
      throw deviceUnavailableError(error, device, path);
    }
    throw error;
  }
  return response.json();
}

function deviceAccessHeaders(device) {
  return device?.accessToken ? { 'X-Access-Token': device.accessToken } : {};
}

function curlDeviceHeaders(device) {
  return device?.accessToken ? ['-H', `X-Access-Token: ${device.accessToken}`] : [];
}

async function getDeviceTaskWithReconnect(device, job, taskId) {
  const path = `/api/downloads/${taskId}?accountHash=${encodeURIComponent(accountHashForJob(job, device))}`;
  const startedAt = Date.now();
  let warned = false;
  let lastError = null;

  while (Date.now() - startedAt <= deviceReconnectGraceMs) {
    try {
      return await unfairdGet(device, path);
    } catch (error) {
      lastError = error;
      if (!isTransientDeviceFetchError(error)) throw error;
      if (!warned) {
        warned = true;
        job.logs.push(`iPhone 连接短暂中断，等待设备恢复（最多 ${Math.round(deviceReconnectGraceMs / 1000)} 秒）。`);
        touch(job, false);
        await saveState();
      }
      await delay(5000);
    }
  }

  throw new Error(`iPhone 解密过程中连接中断超过 ${Math.round(deviceReconnectGraceMs / 1000)} 秒，任务可能因设备重启、SpringBoard 重启或 daemon 重载而中断：${lastError?.message || 'fetch failed'}`);
}

function isTransientDeviceFetchError(error) {
  const text = `${error?.message || ''} ${error?.cause?.code || ''}`.toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('aborted') ||
    text.includes('timeout') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('enotfound') ||
    text.includes('enetunreach') ||
    text.includes('ehostunreach')
  );
}

function isDeviceUnavailableError(error) {
  return error?.deviceUnavailable === true || isTransientDeviceFetchError(error);
}

function isUnavailableDeviceHttpStatus(status) {
  return [502, 503, 504].includes(Number(status));
}

function deviceUnavailableError(error, device, path) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.deviceUnavailable = true;
  tagged.deviceId = device?.id || '';
  tagged.devicePath = path;
  return tagged;
}

async function unfairdPost(device, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (device.accessToken) headers['X-Access-Token'] = device.accessToken;
  const url = `${device.baseUrl}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw deviceUnavailableError(error, device, path);
  }
  if (!response.ok) {
    const responseBody = await response.text();
    const message = readErrorMessage(responseBody, `unfaird POST ${path} failed`);
    const error = new Error(`${message} (HTTP ${response.status})`);
    if (isUnavailableDeviceHttpStatus(response.status)) {
      throw deviceUnavailableError(error, device, path);
    }
    throw error;
  }
  return response.json();
}

async function persistDeviceAccount(device, account) {
  if (!device.accountFile) return;
  await writeFile(resolvePath(device.accountFile), JSON.stringify(account, null, 2));
}

async function loadDeviceAccount(device) {
  if (!device.accountFile) {
    const error = new Error('device accountFile is not configured');
    error.status = 400;
    throw error;
  }
  return loadJson(resolvePath(device.accountFile));
}

async function deviceStatus(device) {
  if (device.enabled === false) return { id: device.id, name: device.name, enabled: false, online: false };
  try {
    const response = await fetch(`${device.baseUrl}/health`, { signal: AbortSignal.timeout(2500) });
    return { id: device.id, name: device.name, enabled: true, online: response.ok, baseUrl: device.baseUrl };
  } catch {
    return { id: device.id, name: device.name, enabled: true, online: false, baseUrl: device.baseUrl };
  }
}

function runCurl(args, input = '') {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(error.code === 'ENOENT' ? 'curl is not installed in the runtime container' : error.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(new Error(stderr.trim() || `curl exited with ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

async function runCurlIfAvailable(args, originalError, input = '') {
  try {
    return await runCurl(args, input);
  } catch (curlError) {
    if (String(curlError?.message || '').includes('curl is not installed')) {
      throw originalError;
    }
    throw curlError;
  }
}

function parseCurlHttp(output) {
  const marker = '\n__HTTP_STATUS__:';
  const index = output.lastIndexOf(marker);
  if (index === -1) return { status: 0, body: output };
  return {
    body: output.slice(0, index),
    status: Number(output.slice(index + marker.length).trim() || 0)
  };
}

function publicAccountInfo(account) {
  return {
    email: account.email || '',
    directoryServicesIdentifier: account.directoryServicesIdentifier || '',
    deviceIdentifier: account.deviceIdentifier || '',
    store: account.store || '',
    pod: account.pod || '',
    cookies: Array.isArray(account.cookies) ? account.cookies.length : 0,
    updatedAt: account.updatedAt || null
  };
}

function isWechatConfigured() {
  const wechat = wechatConfig();
  return Boolean(wechat.appId && wechat.appSecret && wechat.token);
}

function wechatGatewayConfig() {
  return adminSystem.store.getSetting('wechatGateway', config.wechatGateway || {}) || {};
}

function isWechatGatewayConfigured() {
  const gateway = wechatGatewayConfig();
  return Boolean(gateway.baseUrl && gateway.clientId && gateway.clientSecret && gateway.appId);
}

function wechatGatewayClient() {
  return new WechatGatewayClient(wechatGatewayConfig());
}

async function createWechatLoginSession(browserNonce) {
  if (isWechatGatewayConfigured()) {
    return wechatGatewayClient().createLoginSession(browserNonce, 300);
  }
  if (!isWechatConfigured()) {
    const error = new Error('微信公众号网关未配置，请在后台填写网关地址、Client ID、Client Secret 和 AppID。');
    error.status = 501;
    throw error;
  }
  const sessionId = randomId(18);
  const scene = `login_${sessionId.slice(0, 24)}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const session = {
    sessionId,
    scene,
    status: 'pending',
    openid: null,
    expiresAt,
    createdAt: new Date().toISOString(),
    browserNonce
  };
  state.loginSessions = pruneLoginSessions([...(state.loginSessions || []), session]);
  await saveState();

  const qrcode = await createWechatQRCode(scene);
  return {
    sessionId,
    scene,
    status: session.status,
    expiresAt,
    ticket: qrcode.ticket,
    qrcodeUrl: qrcode.url
  };
}

async function handleGatewayEvent(req, res, url) {
  const gateway = wechatGatewayConfig();
  if (!isWechatGatewayConfigured()) {
    json(res, 503, { error: 'wechat gateway is not configured' });
    return;
  }
  const body = await readRawBody(req);
  const timestamp = String(req.headers['x-timestamp'] || '');
  const nonce = String(req.headers['x-nonce'] || '');
  const signature = String(req.headers['x-signature'] || '');
  const clientId = String(req.headers['x-client-id'] || '');
  if (clientId !== gateway.clientId || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    json(res, 401, { error: 'invalid gateway request' });
    return;
  }
  if (!verifyGatewaySignature(gateway.clientSecret, signature, {
    method: req.method,
    path: url.pathname,
    timestamp,
    nonce,
    body
  })) {
    json(res, 401, { error: 'invalid gateway signature' });
    return;
  }
  const event = JSON.parse(body || '{}');
  const userKey = event.appId && event.openId ? `${event.appId}:${event.openId}` : null;
  if (!adminSystem.store.recordWechatEvent({
    eventId: event.eventId,
    type: event.type,
    userKey,
    occurredAt: event.occurredAt,
    payload: event
  })) {
    json(res, 200, { accepted: true, duplicate: true });
    return;
  }
  if (userKey) {
    const user = upsertGatewayUser({
      appId: event.appId,
      openId: event.openId,
      unionId: event.unionId,
      subscribed: event.subscribed !== false,
      eventId: event.eventId
    });
    if (event.type === 'wechat.login.confirmed' && event.sessionId) {
      state.loginSessions ||= [];
      const existing = state.loginSessions.find((item) => item.sessionId === event.sessionId);
      if (existing) {
        existing.status = 'confirmed';
        existing.openid = user.userKey;
        existing.confirmedAt = new Date().toISOString();
      }
      await saveState();
    }
  }
  json(res, 202, { accepted: true });
}

function upsertGatewayUser({ appId, openId, unionId = '', subscribed = true, eventId = '' }) {
  const user = adminSystem.store.upsertWechatUser({
    appid: appId,
    openid: openId,
    unionid: unionId,
    subscribed
  });
  if (subscribed) {
    adminSystem.store.grantWelcomeCredits(user.userKey, 5, eventId || 'first-follow');
  }
  return adminSystem.store.wechatUser(user.userKey);
}

async function createWechatQRCode(scene) {
  const token = await getWechatAccessToken();
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expire_seconds: 300,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: scene } }
    })
  });
  const payload = await response.json();
  if (!response.ok || payload.errcode) {
    throw new Error(`微信二维码创建失败：${payload.errmsg || response.statusText}`);
  }
  return {
    ticket: payload.ticket,
    url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(payload.ticket)}`
  };
}

async function getWechatAccessToken() {
  if (wechatAccessTokenCache.token && wechatAccessTokenCache.expiresAt - 60_000 > Date.now()) {
    return wechatAccessTokenCache.token;
  }
  if (!isWechatConfigured()) {
    throw new Error('微信公众号未配置');
  }
  const params = new URLSearchParams({
    grant_type: 'client_credential',
    appid: wechatConfig().appId,
    secret: wechatConfig().appSecret
  });
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/token?${params}`);
  const payload = await response.json();
  if (!response.ok || payload.errcode || !payload.access_token) {
    throw new Error(`微信 access_token 获取失败：${payload.errmsg || response.statusText}`);
  }
  wechatAccessTokenCache.token = payload.access_token;
  wechatAccessTokenCache.expiresAt = Date.now() + Math.max(300, Number(payload.expires_in || 7200) - 120) * 1000;
  return wechatAccessTokenCache.token;
}

function handleWechatCallbackVerify(req, res, url) {
  if (!isWechatConfigured() || !verifyWechatSignature(url)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(url.searchParams.get('echostr') || '');
}

async function handleWechatEvent(req, res, url) {
  if (!isWechatConfigured() || !verifyWechatSignature(url)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
    return;
  }
  const xml = await readRawBody(req);
  const event = parseWechatXml(xml);
  await applyWechatEvent(event);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('success');
}

function verifyWechatSignature(url) {
  const signature = url.searchParams.get('signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  const expected = sha1([wechatConfig().token, timestamp, nonce].sort().join(''));
  return signature === expected;
}

async function applyWechatEvent(event) {
  const openid = event.FromUserName;
  const type = event.Event;
  if (!openid || !type) return;

  if (type === 'unsubscribe') {
    const user = ensureUser(openid);
    user.subscribed = false;
    user.updatedAt = new Date().toISOString();
    await saveState();
    return;
  }

  const user = ensureUser(openid);
  user.subscribed = true;
  user.lastSeenAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();

  const rawKey = event.EventKey || '';
  const scene = rawKey.startsWith('qrscene_') ? rawKey.slice('qrscene_'.length) : rawKey;
  if ((type === 'subscribe' || type === 'SCAN') && scene.startsWith('login_')) {
    const session = (state.loginSessions || []).find((item) => item.scene === scene && item.status === 'pending');
    if (session && Date.parse(session.expiresAt || '') > Date.now()) {
      session.status = 'confirmed';
      session.openid = openid;
      session.confirmedAt = new Date().toISOString();
    }
  }
  await saveState();
}

async function notifyJobFinished(job, result) {
  if (job.openid && isWechatGatewayConfigured()) {
    const user = adminSystem.store.wechatUser(job.openid);
    if (!user?.openid || !user.subscribed) {
      job.notifyStatus = 'skipped';
      return;
    }
    const taskUrl = job.status === 'completed' && (job.artifactUrl || job.remoteStorage) && job.downloadToken
      ? withDownloadToken(jobDownloadUrl(job), job.downloadToken)
      : `${storageConfig().publicBaseUrl || config.publicBaseUrl || `http://127.0.0.1:${serverPort}`}/jobs#${encodeURIComponent(job.id)}`;
    const status = result === 'completed' ? '应用解密完成' : '应用解密失败';
    adminSystem.store.startNotificationDelivery(job.id, job.openid);
    try {
      await wechatGatewayClient().sendMessage({
        openid: user.openid,
        text: `${job.app?.name || '应用'}：${status}\n${result === 'completed' ? `下载地址：${taskUrl}` : `原因：${job.error || '请进入平台查看'}`}`
      });
      state.notificationWindows ||= {};
      state.notificationWindows[job.openid] = consumeNotificationMessage(state.notificationWindows[job.openid]);
      adminSystem.store.finishNotificationDelivery(job.id, 'sent');
      job.notifyStatus = 'sent';
      job.notifyAttempts = 0;
      job.nextNotifyAttemptAt = null;
      job.notifiedAt = new Date().toISOString();
      await saveState();
    } catch (error) {
      adminSystem.store.finishNotificationDelivery(job.id, 'failed', error.message || String(error));
      throw error;
    }
    return;
  }
  const wechat = wechatConfig();
  if (!job.openid || !isWechatConfigured() || !wechat.templateId) {
    job.notifyStatus = 'skipped';
    return;
  }
  const token = await getWechatAccessToken();
  const taskUrl = job.status === 'completed' && (job.artifactUrl || job.remoteStorage) && job.downloadToken
    ? withDownloadToken(jobDownloadUrl(job), job.downloadToken)
    : `${storageConfig().publicBaseUrl || config.publicBaseUrl || `http://127.0.0.1:${serverPort}`}/jobs#${encodeURIComponent(job.id)}`;
  const payload = {
    touser: job.openid,
    template_id: wechat.templateId,
    url: taskUrl,
    data: wechatTemplateData(job, result)
  };
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok || body.errcode) {
    throw new Error(`模板消息发送失败：${body.errmsg || response.statusText}`);
  }
  job.notifyStatus = 'sent';
  job.notifyAttempts = 0;
  job.nextNotifyAttemptAt = null;
  job.notifiedAt = new Date().toISOString();
  await saveState();
}

function recordNotificationFailure(job, error) {
  const attempts = Number(job.notifyAttempts || 0) + 1;
  job.notifyStatus = attempts >= 8 ? 'dead' : 'failed';
  job.notifyAttempts = attempts;
  job.nextNotifyAttemptAt = attempts >= 8
    ? null
    : new Date(Date.now() + Math.min(30 * 60_000, (2 ** attempts) * 30_000)).toISOString();
  job.logs.push(`微信通知失败（${attempts}/8）：${error.message || String(error)}`);
  touch(job);
  if (attempts >= 8) {
    adminSystem.notifyOperations({
      severity: 'warning',
      title: '微信任务通知进入死信',
      detail: `${job.app?.name || job.id}：${error.message || String(error)}`
    }).catch(console.error);
  }
}

async function retryFailedNotifications() {
  const now = Date.now();
  const candidates = state.jobs.filter((job) =>
    job.notifyStatus === 'failed' &&
    Date.parse(job.nextNotifyAttemptAt || '') <= now &&
    !notificationRetries.has(job.id)
  );
  for (const job of candidates) {
    notificationRetries.add(job.id);
    const result = job.status === 'completed' ? 'completed' : 'failed';
    try {
      await notifyJobFinished(job, result);
    } catch (error) {
      recordNotificationFailure(job, error);
    } finally {
      notificationRetries.delete(job.id);
    }
  }
  if (candidates.length) await saveState();
}

function wechatTemplateData(job, result) {
  const fields = wechatConfig().templateFields || {};
  const values = {
    appName: `${job.app?.name || '应用'} ${job.software?.version ? `v${job.software.version}` : ''}`.trim(),
    status: result === 'completed' ? '应用解密完成' : '应用解密失败',
    finishedAt: formatDateTime(new Date()),
    expiresAt: job.artifactExpiresAt ? formatDateTime(new Date(job.artifactExpiresAt)) : `${formatRetentionMinutes()} 分钟后过期`,
    remark: result === 'completed' ? '点击查看 IPA 下载链接' : (job.error || '请返回平台查看失败日志')
  };
  const defaults = {
    thing1: values.appName,
    phrase2: values.status,
    time3: values.finishedAt,
    thing4: values.expiresAt,
    thing5: values.remark
  };
  const data = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const sourceKey = fields[key] || key;
    data[key] = { value: values[sourceKey] || fallback };
  }
  return data;
}

function createWebSession(openid, identity = {}) {
  const token = randomId(32);
  const maxAgeSeconds = Math.max(3600, Number(wechatConfig().sessionMaxAgeSeconds || 7 * 24 * 3600));
  const session = {
    tokenHash: sha256(token),
    openid,
    appId: identity.appId || '',
    rawOpenId: identity.openId || '',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + maxAgeSeconds * 1000).toISOString()
  };
  state.webSessions = pruneWebSessions([...(state.webSessions || []), session]);
  return { token, maxAgeSeconds, expiresAt: session.expiresAt };
}

function notificationStatusFor(openid) {
  return notificationWindowStatus(state.notificationWindows?.[openid]);
}

function refreshNotificationWindow(openid) {
  state.notificationWindows ||= {};
  state.notificationWindows[openid] = refreshedNotificationWindow();
}

function ensureUser(openid) {
  state.users ||= [];
  let user = state.users.find((item) => item.openid === openid);
  if (!user) {
    user = {
      openid,
      subscribed: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.users.push(user);
  }
  return user;
}

function publicUser(openid) {
  if (String(openid || '').includes(':')) {
    const user = adminSystem.store.wechatUser(openid);
    if (user) {
      return {
        openid: user.openid,
        appId: user.appid,
        userKey: user.userKey,
        subscribed: user.subscribed,
        balance: user.balance
      };
    }
  }
  const user = (state.users || []).find((item) => item.openid === openid);
  return user ? { openid: user.openid, subscribed: user.subscribed !== false } : { openid, subscribed: true };
}

function pruneLoginSessions(sessions) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return sessions.filter((session) => Date.parse(session.createdAt || session.expiresAt || '') > cutoff).slice(-200);
}

function pruneWebSessions(sessions) {
  const now = Date.now();
  return sessions.filter((session) => Date.parse(session.expiresAt || '') > now).slice(-500);
}

function getActor(req, url) {
  const header = req.headers['x-admin-token'];
  const sessionAdmin = adminSystem.currentAdmin(req);
  if (sessionAdmin) {
    return { authenticated: true, type: 'admin', isAdmin: true, admin: sessionAdmin };
  }
  if (config.adminToken && constantTimeEqual(header, config.adminToken)) {
    return { authenticated: true, type: 'admin', isAdmin: true };
  }
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.asspp_session || '';
  if (token) {
    const tokenHash = sha256(token);
    const session = (state.webSessions || []).find((item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt || '') > Date.now());
    if (session) {
      const admins = new Set(wechatConfig().adminOpenids || []);
      return {
        authenticated: true,
        type: 'wechat',
        openid: session.openid,
        appId: session.appId || '',
        rawOpenId: session.rawOpenId || session.openid,
        sessionTokenHash: tokenHash,
        isAdmin: admins.has(session.openid)
      };
    }
  }
  return { authenticated: false, type: 'anonymous', isAdmin: false };
}

function requireActor(req, url) {
  const actor = getActor(req, url);
  if (!actor.authenticated) {
    const error = new Error('unauthorized');
    error.status = 401;
    throw error;
  }
  return actor;
}

async function serveStatic(req, res, url) {
  const file = url.pathname === '/'
    ? 'index.html'
    : url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/')
      ? 'admin.html'
      : url.pathname.slice(1);
  const safe = resolve(join(rootDir, 'public', file));
  const base = resolve(join(rootDir, 'public'));
  if (!safe.startsWith(base)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    await stat(safe);
    res.writeHead(200, { 'Content-Type': contentType(safe) });
    createReadStream(safe).pipe(res);
  } catch {
    const index = join(rootDir, 'public', 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    createReadStream(index).pipe(res);
  }
}

async function serveArtifact(req, res, url) {
  const actor = getActor(req, url);
  const file = basename(decodeURIComponent(url.pathname.replace('/files/', '')));
  const job = state.jobs.find((item) => item.artifactFileName === file || (item.artifactPath && basename(item.artifactPath) === file));
  const downloadToken = url.searchParams.get('downloadToken') || '';
  const tokenAuthorized = Boolean(job?.downloadToken && downloadToken && job.downloadToken === downloadToken);
  if (!actor.authenticated && !tokenAuthorized) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (!job && !actor.isAdmin) {
    res.writeHead(404).end('not found');
    return;
  }
  if (job && !tokenAuthorized && !actor.isAdmin && job.openid !== actor.openid) {
    res.writeHead(404).end('not found');
    return;
  }
  if (job?.status === 'expired' || job?.errorCode === 'artifact_expired') {
    res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }).end('下载链接已过期，请重新创建解密任务。');
    return;
  }
  const artifactPath = join(resolvePath(storageConfig().localDir || './data/artifacts'), file);
  try {
    await stat(artifactPath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}`
    });
    createReadStream(artifactPath).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}

async function serveInternalFile(req, res, url) {
  const file = basename(decodeURIComponent(url.pathname.replace('/internal/files/', '')));
  const token = url.searchParams.get('token') || '';
  const job = state.jobs.find((item) => item.routerSourceFileName === file && item.routerSourceToken === token);
  if (!job || !token) {
    res.writeHead(404).end('not found');
    return;
  }
  const sourcePath = join(resolvePath(storageConfig().localDir || './data/artifacts'), file);
  try {
    const fileStat = await stat(sourcePath);
    const range = parseRangeHeader(req.headers.range, fileStat.size);
    if (range?.invalid) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileStat.size}`,
        'Accept-Ranges': 'bytes'
      }).end();
      return;
    }
    if (range) {
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${fileStat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}`
      });
      createReadStream(sourcePath, { start: range.start, end: range.end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fileStat.size),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}`
    });
    createReadStream(sourcePath).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function parseRangeHeader(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || size <= 0) return { invalid: true };
  let start;
  let end;
  if (match[1] === '' && match[2] === '') return { invalid: true };
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

function requireAdmin(req, url) {
  if (!config.adminToken) return;
  if (!requireHeaderToken(req, config.adminToken)) {
    const error = new Error('unauthorized');
    error.status = 401;
    throw error;
  }
}

async function readJsonBody(req) {
  const body = await readRawBody(req);
  return body ? JSON.parse(body) : {};
}

async function readRawBody(req) {
  return readBoundedBody(req, {
    maxBytes: Math.max(64 * 1024, Number(config.maxRequestBodyBytes || 2 * 1024 * 1024))
  });
}

function applyPublicRateLimit(req, url, res) {
  if (req.method !== 'POST' || !['/api/auth/wechat/start', '/api/cards/redeem', '/api/jobs'].includes(url.pathname)) return;
  const address = String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown').slice(0, 100);
  const result = publicRateLimiter.consume(`${address}:${url.pathname}`);
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    throw Object.assign(new Error('too many requests'), { status: 429 });
  }
}

async function loadState() {
  try {
    const loaded = JSON.parse(await readFile(statePath, 'utf8'));
    return {
      jobs: Array.isArray(loaded.jobs) ? loaded.jobs : [],
      users: Array.isArray(loaded.users) ? loaded.users : [],
      loginSessions: Array.isArray(loaded.loginSessions) ? loaded.loginSessions : [],
      webSessions: Array.isArray(loaded.webSessions) ? loaded.webSessions : [],
      notificationWindows: loaded.notificationWindows && typeof loaded.notificationWindows === 'object'
        ? loaded.notificationWindows
        : {}
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`unable to load platform state without data loss: ${error.message || String(error)}`);
    }
    return { jobs: [], users: [], loginSessions: [], webSessions: [], notificationWindows: {} };
  }
}

async function saveState() {
  await mkdir(dirname(statePath), { recursive: true });
  jobJournal.saveSnapshot(state.jobs);
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

async function loadJson(path, fallbackPath) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (!fallbackPath) throw error;
    return JSON.parse(await readFile(fallbackPath, 'utf8'));
  }
}

function selectDevice(deviceId) {
  return devicePool.strict(deviceId);
}

function normalizeSoftware(software) {
  if (!software || typeof software !== 'object') return null;
  const id = Number(software.id);
  if (!Number.isFinite(id) || !software.name) return null;
  return {
    ...software,
    id,
    bundleID: software.bundleID || software.bundleId || '',
    artworkUrl: software.artworkUrl || software.icon || '',
    screenshotUrls: Array.isArray(software.screenshotUrls) ? software.screenshotUrls : [],
    averageUserRating: Number(software.averageUserRating || 0),
    userRatingCount: Number(software.userRatingCount || 0)
  };
}

function appFromSoftware(software) {
  return {
    id: String(software.id),
    name: software.name,
    bundleId: software.bundleID || String(software.id),
    icon: software.artworkUrl || '',
    category: software.primaryGenreName || 'App Store',
    description: software.description || `${software.artistName || 'App Store'} · v${software.version || 'latest'}`
  };
}

function getJob(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) throw new Error('job not found');
  return job;
}

function touch(job, persist = true) {
  job.updatedAt = new Date().toISOString();
  broadcastJobChange(job);
  if (persist) saveState().catch(console.error);
}

function startJobEventStream(req, res, actor) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
  const client = { res, actor };
  jobEventClients.add(client);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
  const maximumLifetime = setTimeout(() => res.end(), 60 * 60 * 1000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(maximumLifetime);
    jobEventClients.delete(client);
  });
}

function broadcastJobChange(job) {
  if (!jobEventClients.size) return;
  const payload = `event: job.changed\ndata: ${JSON.stringify({ id: job.id, updatedAt: job.updatedAt })}\n\n`;
  for (const client of jobEventClients) {
    if (!client.actor.isAdmin && client.actor.openid !== job.openid) continue;
    try {
      client.res.write(payload);
    } catch {
      jobEventClients.delete(client);
    }
  }
}

async function failJob(jobId, error) {
  const job = getJob(jobId);
  await deleteRouterSourceArtifact(job).catch(() => {});
  const rawMessage = error instanceof Error ? error.message : String(error);
  const classified = classifyJobError(rawMessage, error?.code);
  finishCurrentAttempt(job, 'failed', classified);
  adminSystem.store.releaseAppleAccount(job.id, rawMessage);
  job.status = classified.status;
  job.error = classified.message;
  job.errorCode = classified.code;
  job.logs.push(`${classified.logPrefix}：${classified.message}`);
  refundJobCredit(job);
  touch(job);
  await notifyJobFinished(job, 'failed').catch((notifyError) => {
    recordNotificationFailure(job, notifyError);
  });
  await adminSystem.notifyOperations({
    severity: classified.code === 'device_offline' ? 'critical' : 'warning',
    title: '应用解密任务失败',
    detail: `${job.app?.name || job.app?.bundleId || job.id}：${classified.message}`
  }).catch(() => {});
}

async function handleJobFailure(jobId, error) {
  const job = getJob(jobId);
  await deleteRouterSourceArtifact(job).catch(() => {});
  const rawMessage = error instanceof Error ? error.message : String(error);
  const classified = classifyJobError(rawMessage, error?.code);
  finishCurrentAttempt(job, 'failed', classified);
  adminSystem.store.releaseAppleAccount(job.id, rawMessage);
  if (classified.retryScope === 'next-account' && job.appleAccountId) {
    job.excludedAppleAccountIds = [...new Set([
      ...(job.excludedAppleAccountIds || []),
      job.appleAccountId
    ])];
    job.appleAccountId = null;
    job.appleAccountLabel = null;
  }

  if (canRetryJob(job, classified)) {
    const failedDeviceId = job.deviceId;
    const sameDeviceRetry = ['same-device', 'next-account'].includes(classified.retryScope)
      && attemptsForDevice(job, failedDeviceId) < 2;
    if (!sameDeviceRetry && failedDeviceId) {
      job.excludedDeviceIds = [...new Set([...(job.excludedDeviceIds || []), failedDeviceId])];
    }
    job.status = 'queued';
    updateWorkflowProgress(job, 'queued', 0, { reset: true });
    job.speed = '';
    job.error = null;
    job.errorCode = null;
    job.unfairdTaskId = null;
    job.accountHash = null;
    job.deviceId = null;
    if (sameDeviceRetry) job.preferredDeviceId = failedDeviceId;
    job.logs.push(`自动重试：${classified.message}（${retrySummary(job)}）`);
    touch(job);
    return;
  }

  job.status = classified.status;
  job.error = classified.message;
  job.errorCode = classified.code;
  job.logs.push(`${classified.logPrefix}：${classified.message}`);
  refundJobCredit(job);
  touch(job);
  await notifyJobFinished(job, 'failed').catch((notifyError) => {
    recordNotificationFailure(job, notifyError);
  });
  await adminSystem.notifyOperations({
    severity: classified.code === 'device_offline' ? 'critical' : 'warning',
    title: '应用解密任务最终失败',
    detail: `${job.app?.name || job.app?.bundleId || job.id}：${classified.message}（${retrySummary(job)}）`
  }).catch(() => {});
}

function refundJobCredit(job) {
  if (!job.creditCharged || !job.openid || job.creditRefunded) return;
  const balance = adminSystem.store.refundCredit(job.openid, job.id);
  if (balance == null) return;
  job.creditRefunded = true;
  job.logs.push(`任务未完成，已退回 1 次额度；当前余额 ${balance} 次。`);
}

function classifyJobError(message, sourceCode = '') {
  const text = String(message || '').trim() || '未知错误';
  const lower = text.toLowerCase();
  const code = String(sourceCode || '').toLowerCase();
  if (lower.includes('管理员已取消任务')) {
    return {
      status: 'cancelled',
      code: 'job_cancelled',
      logPrefix: '取消',
      message: '管理员已取消任务'
    };
  }
  if (isAlreadyPurchasedError(text)) {
    return {
      status: 'failed',
      code: 'apple_license_already_exists',
      logPrefix: '失败',
      message: '账号已拥有该 App Store 许可证。请重新发送任务，平台会跳过获取许可证并直接下载砸壳。'
    };
  }
  if (code === 'insufficient_storage' || lower.includes('insufficient storage') || lower.includes('free space')) {
    return {
      status: 'failed',
      code: 'insufficient_storage',
      logPrefix: '空间不足',
      message: `iPhone 可用空间不足：${text}`,
      retryable: true,
      retryScope: 'next-device'
    };
  }
  if (
    lower.includes('verification code') ||
    lower.includes('trusted-device') ||
    lower.includes('two-factor') ||
    lower.includes('2fa') ||
    lower.includes('authenticate') && lower.includes('code')
  ) {
    return {
      status: 'needs_verification',
      code: 'apple_verification_required',
      logPrefix: '需要验证',
      message: '当前 Apple ID 需要二次验证，平台将优先切换到其他可用账户。',
      retryable: true,
      retryScope: 'next-account'
    };
  }
  if (lower.includes('requested url returned error: 409') || lower.includes('failed: 409')) {
    return {
      status: 'failed',
      code: 'apple_license_required',
      logPrefix: '失败',
      message: 'App Store 返回 409，通常表示该账号还没有这个应用的下载许可证，或许可证获取被 Apple 拦截。请先获取许可证后再下载。'
    };
  }
  if (lower === 'fetch failed' || lower.includes('iphone 解密过程中连接中断') || lower.includes('task interrupted while decrypting')) {
    return {
      status: 'failed',
      code: 'iphone_decrypt_interrupted',
      logPrefix: '失败',
      message: 'iPhone 解密过程中连接/任务中断，通常是设备热重启、SpringBoard 重启、daemon 重载或内存压力导致。',
      retryable: true,
      retryScope: lower === 'fetch failed' ? 'same-device' : 'next-device'
    };
  }
  if (
    lower.includes('code 137') ||
    lower.includes('task_for_pid') ||
    lower.includes('permission setup failed') ||
    lower.includes('jbclient apis are unavailable') ||
    lower.includes('trollstore failed to install') ||
    lower.includes('install-appstore failed') ||
    lower.includes('installed app not found') ||
    lower.includes('no ipa install provider found') ||
    lower.includes('appinst unavailable') ||
    lower.includes('appinst failed') ||
    lower.includes('applicationverificationfailed') ||
    lower.includes('extension launch did not produce a pid')
  ) {
    return {
      status: 'failed',
      code: 'device_runtime_failed',
      logPrefix: '失败',
      message: text,
      retryable: true,
      retryScope: 'next-device'
    };
  }
  if (
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up') ||
    lower.includes('network') ||
    lower.includes('timeout')
  ) {
    return {
      status: 'failed',
      code: 'network_transient',
      logPrefix: '失败',
      message: text,
      retryable: true,
      retryScope: 'same-device'
    };
  }
  return {
    status: 'failed',
    code: 'job_failed',
    logPrefix: '失败',
    message: text
  };
}

function deviceTaskFailure(task) {
  const error = new Error(extractErrorMessage(task, 'iPhone 任务失败（设备未返回详细原因）'));
  error.code = task?.errorCode || 'device_task_failed';
  return error;
}

function isAlreadyPurchasedError(message) {
  const lower = String(message || '').toLowerCase();
  return lower.includes('already purchased') || lower.includes('failuretype: 5002') || lower.includes('failuretype=5002');
}

function mapTaskStatus(status) {
  if (status === 'pending') return 'running';
  if (status === 'downloading') return 'downloading';
  if (status === 'decrypting' || status === 'injecting') return 'decrypting';
  if (status === 'completed') return 'uploading';
  return status || 'running';
}

function mergeLogs(existing, incoming) {
  const seen = new Set(existing);
  const result = [...existing];
  for (const line of incoming) {
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }
  return result.slice(-300);
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const secure = req.headers['x-forwarded-proto'] === 'https'
    || String(config.publicBaseUrl || '').startsWith('https://')
    || String(storageConfig().publicBaseUrl || '').startsWith('https://');
  const value = token
    ? `asspp_session=${encodeURIComponent(token)}; Max-Age=${Math.max(0, maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
    : `asspp_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', value);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function parseWechatXml(xml) {
  const result = {};
  const pattern = new RegExp('<(?!xml\\\\b)([A-Za-z0-9_]+)>(?:<!\\\\[CDATA\\\\[([\\\\s\\\\S]*?)\\\\]\\\\]>|([^<]*?))</\\\\1>', 'g');
  let match;
  while ((match = pattern.exec(xml))) {
    result[match[1]] = (match[2] ?? match[3] ?? '').trim();
  }
  return result;
}

function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function randomId(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

function formatDateTime(date) {
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function withDownloadToken(url, token) {
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}downloadToken=${encodeURIComponent(token)}`;
}

function jobDownloadUrl(job) {
  const base = storageConfig().publicBaseUrl || config.publicBaseUrl || `http://127.0.0.1:${serverPort}`;
  return `${String(base).replace(/\/$/, '')}/api/jobs/${encodeURIComponent(job.id)}/download`;
}

function contentType(path) {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function formatRetentionMinutes() {
  return Math.round(artifactRetentionMilliseconds() / 60 / 1000);
}

function storageConfig() {
  return adminSystem.store.getSetting('storage', config.storage || {}) || {};
}

function wechatConfig() {
  const notifications = adminSystem.store.getSetting('notifications', null);
  return notifications?.wechat || config.wechat || {};
}

function artifactRetentionMilliseconds() {
  return Math.max(1, Number(storageConfig().artifactRetentionMinutes ?? 30)) * 60 * 1000;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function resolvePath(path) {
  if (!path) return rootDir;
  return path.startsWith('/') ? path : resolve(rootDir, path);
}

function sanitizeFilename(value) {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function createJobTransferReporter(job, stage, expectedBytes = 0) {
  let previousAt = Date.now();
  let previousBytes = 0;
  let lastRenderAt = 0;
  return (written, reportedTotal = 0) => {
    const now = Date.now();
    const total = Number(reportedTotal || expectedBytes || 0);
    const elapsed = Math.max(1, now - previousAt);
    const delta = Math.max(0, written - previousBytes);
    if (delta > 0) job.speed = `${formatBytes(delta * 1000 / elapsed)}/s`;
    previousAt = now;
    previousBytes = written;
    if (now - lastRenderAt < 250 && (!total || written < total)) return;
    const localProgress = total > 0 ? Math.min(100, written / total * 100) : 0;
    updateWorkflowProgress(job, stage, localProgress);
    touch(job, false);
    lastRenderAt = now;
  };
}

async function streamToFile(body, outputPath, { totalBytes = 0, onProgress = null } = {}) {
  await mkdir(dirname(outputPath), { recursive: true });
  let written = 0;
  const tracker = new Transform({
    transform(chunk, encoding, callback) {
      written += chunk.length;
      onProgress?.(written, totalBytes);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(body), tracker, createWriteStream(outputPath));
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
