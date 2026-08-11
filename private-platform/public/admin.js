const authRoot = document.querySelector('#adminAuth');
const appRoot = document.querySelector('#adminApp');
const modal = document.querySelector('#adminModal');
const modalContent = document.querySelector('#adminModalContent');
const toastRoot = document.querySelector('#adminToast');
const sections = [...document.querySelectorAll('[data-admin-section]')];
const navButtons = [...document.querySelectorAll('#adminNav [data-section]')];
const mobileNav = document.querySelector('#adminMobileNav');
const themeToggle = document.querySelector('#adminThemeToggle');
const themeLabel = document.querySelector('#adminThemeLabel');

let currentAdmin = null;
let groups = [];
let devices = [];
let appleAccounts = [];
let eventSource = null;
let jobPollTimer = null;
let currentBoardJobs = [];
let currentJobFilter = null;

const sectionCache = new Map();
const sectionInflight = new Map();
const SECTION_CACHE_REFRESH_MS = 2_000;

function cacheGet(key) {
  const entry = sectionCache.get(key);
  return entry ? entry.data : null;
}

function cacheSet(key, data) {
  sectionCache.set(key, { data, at: Date.now() });
}

function invalidateCache(key) {
  sectionCache.delete(key);
}

function startCachedFetch(key, fetcher) {
  const inflight = fetcher()
    .then((data) => {
      cacheSet(key, data);
      return data;
    })
    .finally(() => sectionInflight.delete(key));
  sectionInflight.set(key, inflight);
  return inflight;
}

function cachedLoad(key, fetcher) {
  const entry = sectionCache.get(key);
  const inflight = sectionInflight.get(key);
  if (entry) {
    const freshPromise = inflight
      || (Date.now() - entry.at > SECTION_CACHE_REFRESH_MS ? startCachedFetch(key, fetcher) : null);
    return Promise.resolve({ data: entry.data, stale: Boolean(freshPromise), freshPromise });
  }
  if (inflight) {
    return inflight.then((data) => ({ data, stale: false, freshPromise: null }));
  }
  const pending = startCachedFetch(key, fetcher);
  return pending.then((data) => ({ data, stale: false, freshPromise: null }));
}

async function cachedSection(keys, render) {
  try {
    const results = await Promise.all(keys.map(({ key, fetcher }) => cachedLoad(key, fetcher)));
    render(...results.map((result) => result.data));
    const pending = results.flatMap((result) => (result.freshPromise ? [result.freshPromise] : []));
    if (pending.length) {
      await Promise.allSettled(pending);
      render(...keys.map(({ key }, index) => cacheGet(key) || results[index].data));
    }
  } catch (error) {
    toast(error.message);
  }
}

const SECTION_LOAD_TARGETS = {
  overview: '#overviewMetrics',
  jobs: '#adminJobList',
  devices: '#deviceAdminList',
  accounts: '#appleAccountList',
  cards: '#cardBatchList',
  storage: '#storageForm',
  notifications: '#notificationForm',
  admins: '#adminUserList',
  audit: '#auditList'
};

const SECTION_CACHE_KEYS = {
  overview: ['admin:dashboard', 'devices'],
  jobs: ['admin:jobs', 'devices'],
  devices: ['devices', 'admin:device-groups', 'admin:scheduler'],
  accounts: ['admin:apple-accounts', 'devices'],
  cards: ['admin:cards'],
  storage: ['admin:storage'],
  notifications: ['admin:notifications'],
  admins: ['admin:admins'],
  audit: ['admin:audit']
};

function sectionHasCache(name) {
  return (SECTION_CACHE_KEYS[name] || []).every((key) => sectionCache.has(key));
}

function showSectionLoading(name) {
  const selector = SECTION_LOAD_TARGETS[name];
  if (!selector) return;
  const panel = sections.find((section) => section.dataset.adminSection === name);
  const target = panel?.querySelector(selector);
  if (target) target.innerHTML = '<div class="admin-loading" aria-busy="true">加载中…</div>';
}

const STOREFRONTS = [
  { code: 'cn', label: '中国大陆' },
  { code: 'us', label: '美国' },
  { code: 'jp', label: '日本' },
  { code: 'hk', label: '香港' },
  { code: 'tw', label: '台湾' }
];

document.querySelectorAll('[data-close-modal]').forEach((button) => {
  button.addEventListener('click', closeModal);
});
document.querySelector('#adminLogout')?.addEventListener('click', logout);
document.querySelector('#refreshOverview')?.addEventListener('click', loadOverview);
document.querySelector('#refreshAdminJobs')?.addEventListener('click', loadAdminJobs);
document.querySelector('#refreshAudit')?.addEventListener('click', loadAudit);
document.querySelector('#addDeviceButton')?.addEventListener('click', () => openDeviceForm());
document.querySelector('#addAppleAccountButton')?.addEventListener('click', () => openAppleAccountForm());
document.querySelector('#appleLoginButton')?.addEventListener('click', openAppleLoginForm);
document.querySelector('#syncAppleAccountButton')?.addEventListener('click', openSyncAppleAccountForm);
document.querySelector('#createCardsButton')?.addEventListener('click', openCardBatchForm);
document.querySelector('#addAdminButton')?.addEventListener('click', openAdminForm);
navButtons.forEach((button) => button.addEventListener('click', () => showSection(button.dataset.section)));
mobileNav?.addEventListener('change', () => showSection(mobileNav.value));
themeToggle?.addEventListener('click', toggleAdminTheme);

syncAdminThemeControl();

boot();

function toggleAdminTheme() {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  try {
    localStorage.setItem('asspp-admin-theme', nextTheme);
  } catch {}
  syncAdminThemeControl();
}

function syncAdminThemeControl() {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (themeLabel) themeLabel.textContent = dark ? '浅色模式' : '深色模式';
  themeToggle?.setAttribute('aria-label', dark ? '切换为浅色模式' : '切换为深色模式');
  themeToggle?.setAttribute('aria-pressed', String(dark));
}

async function boot() {
  const me = await api('/api/admin/auth/me').catch(() => ({ authenticated: false }));
  if (me.authenticated) {
    enterApp(me.admin);
    return;
  }
  const status = await api('/api/admin/bootstrap/status');
  if (status.bootstrapRequired) {
    showBootstrap(status);
  } else {
    showLogin();
  }
}

function enterApp(admin) {
  currentAdmin = admin;
  authRoot.hidden = true;
  appRoot.hidden = false;
  document.querySelector('#adminIdentity').textContent = `${admin.username} · ${roleLabel(admin.role)}`;
  showSection('overview');
  connectEvents();
  bindJobDetailBack();
  clearInterval(jobPollTimer);
  jobPollTimer = setInterval(() => {
    if (document.querySelector('#adminNav button.active')?.dataset.section === 'jobs') loadAdminJobs();
  }, 30_000);
}

function showBootstrap(status) {
  appRoot.hidden = true;
  authRoot.hidden = false;
  authRoot.innerHTML = `
    <section class="admin-auth-card">
      <span class="brand-mark" aria-hidden="true">91</span>
      <h1>初始化管理后台</h1>
      <p>创建首个超级管理员。密码至少 12 位，随后需要绑定 Authenticator TOTP。</p>
      ${status.masterKeyConfigured ? '' : '<div class="alert" data-tone="warning">系统加密服务尚未完成配置。请完成安全配置后再保存账户或存储凭据。</div>'}
      <form id="bootstrapForm" class="admin-auth-form">
        <label class="admin-field">
          <span>旧管理员 Token</span>
          <input class="field-input" name="legacyToken" type="password" required autocomplete="current-password">
        </label>
        <label class="admin-field">
          <span>管理员用户名</span>
          <input class="field-input" name="username" required minlength="3" autocomplete="username">
        </label>
        <label class="admin-field">
          <span>管理员密码</span>
          <input class="field-input" name="password" type="password" required minlength="12" autocomplete="new-password">
        </label>
        <button class="btn btn-primary" type="submit">创建并绑定 TOTP</button>
      </form>
    </section>
  `;
  document.querySelector('#bootstrapForm').addEventListener('submit', submitBootstrap);
}

async function submitBootstrap(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const value = await api('/api/admin/bootstrap', {
      method: 'POST',
      headers: { 'X-Admin-Token': form.get('legacyToken') },
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password')
      })
    });
    authRoot.innerHTML = `
      <section class="admin-auth-card">
        <span class="brand-mark" aria-hidden="true">91</span>
        <h1>绑定 TOTP</h1>
        <p>将以下密钥添加到 Authenticator、1Password 或其他 TOTP 应用，然后输入当前 6 位验证码。</p>
        <div class="admin-secret">${escapeHtml(value.secret)}</div>
        <details>
          <summary>显示 otpauth 地址</summary>
          <div class="admin-secret">${escapeHtml(value.otpauthUrl)}</div>
        </details>
        <form id="confirmBootstrapForm" class="admin-auth-form">
          <input name="username" type="hidden" value="${escapeHtml(value.username)}">
          <label class="admin-field">
            <span>6 位验证码</span>
            <input class="field-input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code">
          </label>
          <button class="btn btn-primary" type="submit">确认并进入后台</button>
        </form>
      </section>
    `;
    document.querySelector('#confirmBootstrapForm').addEventListener('submit', async (confirmEvent) => {
      confirmEvent.preventDefault();
      const confirmForm = new FormData(confirmEvent.currentTarget);
      const result = await api('/api/admin/bootstrap/confirm', {
        method: 'POST',
        body: JSON.stringify({
          username: confirmForm.get('username'),
          code: confirmForm.get('code')
        })
      });
      enterApp(result.admin);
    });
  } catch (error) {
    toast(error.message);
  }
}

function showLogin() {
  appRoot.hidden = true;
  authRoot.hidden = false;
  authRoot.innerHTML = `
    <section class="admin-auth-card">
      <span class="brand-mark" aria-hidden="true">91</span>
      <h1>管理员登录</h1>
      <p>使用管理员账号、密码和 Authenticator 验证码登录。</p>
      <form id="adminLoginForm" class="admin-auth-form">
        <label class="admin-field">
          <span>用户名</span>
          <input class="field-input" name="username" required autocomplete="username">
        </label>
        <label class="admin-field">
          <span>密码</span>
          <input class="field-input" name="password" type="password" required autocomplete="current-password">
        </label>
        <label class="admin-field">
          <span>6 位验证码</span>
          <input class="field-input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code">
        </label>
        <button class="btn btn-primary" type="submit">登录</button>
      </form>
    </section>
  `;
  document.querySelector('#adminLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form))
      });
      enterApp(result.admin);
    } catch (error) {
      toast(error.message);
    }
  });
}

async function logout() {
  await api('/api/admin/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  if (eventSource) eventSource.close();
  clearInterval(jobPollTimer);
  currentAdmin = null;
  showLogin();
}

async function showSection(name) {
  sections.forEach((section) => { section.hidden = section.dataset.adminSection !== name; });
  navButtons.forEach((button) => button.classList.toggle('active', button.dataset.section === name));
  if (mobileNav) mobileNav.value = name;
  if (!sectionHasCache(name)) showSectionLoading(name);
  if (name === 'overview') await loadOverview();
  if (name === 'jobs') await loadAdminJobs();
  if (name === 'devices') await loadDevices();
  if (name === 'accounts') await loadAppleAccounts();
  if (name === 'cards') await loadCardBatches();
  if (name === 'storage') await loadStorage();
  if (name === 'notifications') await loadNotifications();
  if (name === 'admins') await loadAdmins();
  if (name === 'audit') await loadAudit();
}

async function loadOverview() {
  await cachedSection([
    { key: 'admin:dashboard', fetcher: () => api('/api/admin/dashboard') },
    { key: 'devices', fetcher: () => api('/api/admin/devices') }
  ], (dashboard, deviceRows) => {
    devices = deviceRows;
    const warning = document.querySelector('#adminWarning');
    warning.hidden = dashboard.masterKeyConfigured;
    warning.textContent = dashboard.masterKeyConfigured
      ? ''
      : '系统加密服务尚未完成配置，暂时无法安全保存账户或存储凭据。请联系系统管理员。';
    const ovMetrics = [
      { label: '设备总数', value: dashboard.devices.total, icon: '<rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect>', tone: '', detail: `${dashboard.devices.online} 台在线` },
      { label: '在线设备', value: dashboard.devices.online, icon: '<circle cx="12" cy="12" r="9"></circle><path d="M9 12l2 2 4-4"></path>', tone: 'tone-success', detail: `共 ${dashboard.devices.total} 台` },
      { label: '已隔离设备', value: dashboard.devices.quarantined, icon: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4M12 17h.01"></path>', tone: dashboard.devices.quarantined ? 'tone-warning' : '', detail: dashboard.devices.quarantined ? '需检查设备' : '运行正常' },
      { label: '队列 / 执行', value: `${dashboard.jobs.queued} / ${dashboard.jobs.active}`, icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>', tone: 'tone-accent', detail: `${dashboard.jobs.queued} 等待 · ${dashboard.jobs.active} 运行中` },
      { label: '可用兑换码', value: dashboard.cards.available, icon: '<rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path>', tone: '', detail: dashboard.cards.available ? '可继续发放' : '库存不足' }
    ];
    document.querySelector('#overviewMetrics').innerHTML = ovMetrics.map((m) => `<article class="admin-metric ${m.tone}"><span class="admin-metric-head"><svg class="admin-metric-icon" viewBox="0 0 24 24" aria-hidden="true">${m.icon}</svg>${m.label}</span><strong>${m.value}</strong><span class="admin-metric-detail">${m.detail}</span></article>`).join('');
    document.querySelector('#overviewDevices').innerHTML = deviceTable(deviceRows);
  });
}


async function loadAdminJobs() {
  await cachedSection([
    { key: 'admin:jobs', fetcher: () => api('/api/admin/jobs') },
    { key: 'devices', fetcher: () => api('/api/admin/devices') }
  ], (jobs, deviceRows) => {
    devices = deviceRows;
    currentBoardJobs = jobs;
    renderJobBoardOrDetail(jobs);
  });
}



const JOB_STATUS_GROUPS = {
  all: (job) => true,
  queued: (job) => job.status === 'queued',
  active: (job) => ['running', 'downloading', 'decrypting', 'uploading'].includes(job.status),
  completed: (job) => job.status === 'completed',
  failed: (job) => ['failed', 'interrupted', 'needs_verification'].includes(job.status),
  cancelled: (job) => job.status === 'cancelled'
};

const JOB_FILTER_LABELS = {
  all: '全部任务',
  queued: '排队中',
  active: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

const JOB_METRIC_ICONS = {
  all: '<path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z"></path>',
  queued: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2.5"></path>',
  active: '<path d="M8 5.5v13l11-6.5z"></path>',
  completed: '<circle cx="12" cy="12" r="8.5"></circle><path d="M8.5 12.2l2.4 2.4 4.8-5"></path>',
  failed: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.8v5.6M12 16.2v.1"></path>',
  cancelled: '<circle cx="12" cy="12" r="8.5"></circle><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"></path>',
  'success-rate': '<path d="M4.5 16.5l5-5 3 3 7-8"></path><path d="M15 6.5h4v4"></path>'
};

const JOB_ACTIVE_SUB_LABELS = {
  running: '处理中',
  downloading: '获取应用',
  decrypting: '解密中',
  uploading: '生成文件'
};

function statusTrendFor(jobs, predicate) {
  const buckets = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    buckets.push({ start: day.getTime(), end: day.getTime() + 86400000, count: 0 });
  }
  for (const job of jobs) {
    if (!predicate(job)) continue;
    const created = job.createdAt ? Date.parse(job.createdAt) : NaN;
    const bucket = buckets.find((item) => created >= item.start && created < item.end);
    if (bucket) bucket.count += 1;
  }
  return buckets.map((item) => item.count);
}

function jobMetricCards(jobs) {
  const counts = Object.fromEntries(Object.keys(JOB_STATUS_GROUPS).map((key) => [key, 0]));
  for (const job of jobs) {
    for (const key of Object.keys(JOB_STATUS_GROUPS)) {
      if (JOB_STATUS_GROUPS[key](job)) counts[key] += 1;
    }
  }
  const finished = counts.completed + counts.failed;
  const successRate = finished ? Math.round((counts.completed / finished) * 100) : null;
  const activeSub = ['running', 'downloading', 'decrypting', 'uploading']
    .map((status) => [status, jobs.filter((job) => job.status === status).length])
    .filter(([, count]) => count > 0);
  const cards = [
    {
      key: 'all',
      label: '全部任务',
      value: counts.all,
      tone: 'neutral',
      icon: JOB_METRIC_ICONS.all,
      detail: `${counts.queued + counts.active} 个待处理`,
      spark: statusTrendFor(jobs, () => true)
    },
    {
      key: 'queued',
      label: '排队中',
      value: counts.queued,
      tone: 'info',
      icon: JOB_METRIC_ICONS.queued,
      detail: counts.queued ? '等待空闲设备' : '队列为空',
      spark: statusTrendFor(jobs, (job) => job.status === 'queued')
    },
    {
      key: 'active',
      label: '执行中',
      value: counts.active,
      tone: 'accent',
      icon: JOB_METRIC_ICONS.active,
      detail: activeSub.length
        ? activeSub.map(([status, count]) => `${JOB_ACTIVE_SUB_LABELS[status] || status} ${count}`).join(' · ')
        : '暂无执行任务',
      spark: statusTrendFor(jobs, (job) => ['running', 'downloading', 'decrypting', 'uploading'].includes(job.status))
    },
    {
      key: 'completed',
      label: '已完成',
      value: counts.completed,
      tone: 'success',
      icon: JOB_METRIC_ICONS.completed,
      detail: `成功率 ${successRate != null ? `${successRate}%` : '--'}`,
      spark: statusTrendFor(jobs, (job) => job.status === 'completed')
    },
    {
      key: 'failed',
      label: '失败',
      value: counts.failed,
      tone: 'danger',
      icon: JOB_METRIC_ICONS.failed,
      detail: `${counts.cancelled} 个已取消`,
      spark: statusTrendFor(jobs, (job) => ['failed', 'interrupted', 'needs_verification'].includes(job.status))
    },
    {
      key: 'cancelled',
      label: '已取消',
      value: counts.cancelled,
      tone: 'muted',
      icon: JOB_METRIC_ICONS.cancelled,
      detail: '人工取消或已过期',
      spark: statusTrendFor(jobs, (job) => job.status === 'cancelled')
    }
  ];
  if (successRate != null) {
    cards.push({
      key: 'success-rate',
      label: '成功率',
      value: `${successRate}%`,
      tone: 'success',
      icon: JOB_METRIC_ICONS['success-rate'],
      detail: `${counts.completed} 成功 / ${finished} 已结束`,
      spark: statusTrendFor(jobs, (job) => job.status === 'completed')
    });
  }
  return cards;
}

function jobTrend(jobs, days = 7) {
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    buckets.push({ label: `${day.getMonth() + 1}/${day.getDate()}`, created: 0, completed: 0, day: day.getTime() });
  }
  for (const job of jobs) {
    const created = job.createdAt ? Date.parse(job.createdAt) : NaN;
    const updated = job.updatedAt ? Date.parse(job.updatedAt) : NaN;
    for (const bucket of buckets) {
      const next = bucket.day + 86400000;
      if (created >= bucket.day && created < next) bucket.created += 1;
      if (job.status === 'completed' && updated >= bucket.day && updated < next) bucket.completed += 1;
    }
  }
  return buckets;
}

function renderTrendChart(buckets) {
  const max = Math.max(1, ...buckets.flatMap((bucket) => [bucket.created, bucket.completed]));
  return `
    <div class="job-trend-chart">
      <div class="job-trend-grid">
        ${buckets.map((bucket) => `
          <button class="job-trend-col" type="button" data-job-filter="day:${bucket.day}" data-job-title="${bucket.label} 创建任务">
            <span class="job-trend-bars">
              <i class="job-trend-bar created" style="height:${Math.round((bucket.created / max) * 100)}%" title="创建 ${bucket.created}"></i>
              <i class="job-trend-bar completed" style="height:${Math.round((bucket.completed / max) * 100)}%" title="完成 ${bucket.completed}"></i>
            </span>
            <span class="job-trend-day">${bucket.label}<small>${bucket.created || bucket.completed ? `${bucket.created} / ${bucket.completed}` : ''}</small></span>
          </button>
        `).join('')}
      </div>
      <div class="job-chart-legend"><i class="legend-dot created"></i>创建 <i class="legend-dot completed"></i>完成</div>
    </div>`;
}

function jobDistribution(jobs) {
  const total = Math.max(1, jobs.length);
  return Object.keys(JOB_STATUS_GROUPS).slice(1).map((key) => ({
    key,
    label: JOB_FILTER_LABELS[key],
    count: jobs.filter(JOB_STATUS_GROUPS[key]).length,
    tone: { queued: 'info', active: 'accent', completed: 'success', failed: 'danger', cancelled: 'muted' }[key],
    percent: Math.round((jobs.filter(JOB_STATUS_GROUPS[key]).length / total) * 100)
  }));
}

function jobTopApps(jobs, limit = 5) {
  const counts = new Map();
  for (const job of jobs) {
    const name = job.app?.name || job.app?.bundleId || '未知应用';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function renderJobBoard(jobs) {
  currentJobFilter = null;
  document.querySelector('#jobDetailHeader').hidden = true;
  document.querySelector('#adminJobList').innerHTML = '';
  // Layered board (ui-ux-pro-max: visual-hierarchy + bullet chart for KPIs)
  const cards = jobMetricCards(jobs);
  const byKey = Object.fromEntries(cards.map((card) => [card.key, card]));
  const total = jobs.length || 1;
  const pct = (n) => Math.round((n / total) * 100);
  const sparkHtml = (spark) => {
    const peak = Math.max(...spark, 1);
    return `<span class="job-metric-spark" aria-hidden="true">${spark.map((count) => `<i style="height:${Math.max(4, Math.round((count / peak) * 28))}px"></i>`).join('')}</span>`;
  };
  const ring = (percent) => {
    const r = 26;
    const circ = (2 * Math.PI * r).toFixed(1);
    const off = (circ - (Math.max(0, Math.min(100, percent)) / 100) * circ).toFixed(1);
    return `<svg class="board-ring" viewBox="0 0 64 64" aria-hidden="true"><circle class="board-ring-track" cx="32" cy="32" r="${r}"></circle><circle class="board-ring-fill" cx="32" cy="32" r="${r}" stroke-dasharray="${circ}" stroke-dashoffset="${off}"></circle></svg>`;
  };
  const all = byKey.all;
  const active = byKey.active;
  const statusCards = ['queued', 'completed', 'failed', 'cancelled'].map((key) => byKey[key]).filter(Boolean);
  const success = byKey['success-rate'];
  const successPct = success ? Number(String(success.value).replace(/[^0-9]/g, '')) : null;
  document.querySelector('#jobBoardMetrics').innerHTML = `
    <div class="board-hero">
      <button class="board-hero-card tone-neutral" type="button" data-job-filter="status:all" data-job-title="全部任务">
        <span class="board-hero-head">
          <svg class="job-metric-icon" viewBox="0 0 24 24" aria-hidden="true">${all.icon}</svg>
          <span class="job-metric-label">全部任务</span>
        </span>
        <strong class="board-hero-value">${all.value}</strong>
        <span class="job-metric-detail">${all.detail || ''}</span>
        ${sparkHtml(all.spark)}
      </button>
      <button class="board-hero-card tone-accent" type="button" data-job-filter="status:active" data-job-title="执行中">
        <span class="board-hero-head">
          <svg class="job-metric-icon" viewBox="0 0 24 24" aria-hidden="true">${active.icon}</svg>
          <span class="job-metric-label">执行中</span>
        </span>
        <strong class="board-hero-value">${active.value}</strong>
        <span class="job-metric-detail">${active.detail || '暂无执行任务'}</span>
        ${sparkHtml(active.spark)}
      </button>
    </div>
    <div class="board-status-grid">
      ${statusCards.map((card) => `
        <button class="board-status-card tone-${card.tone}" type="button" data-job-filter="status:${card.key}" data-job-title="${card.label}">
          <span class="board-status-top">
            <svg class="job-metric-icon" viewBox="0 0 24 24" aria-hidden="true">${card.icon}</svg>
            <span class="job-metric-label">${card.label}</span>
          </span>
          <span class="board-status-num"><strong>${card.value}</strong><small>${pct(card.value)}%</small></span>
          <span class="bullet" aria-hidden="true"><i class="bullet-fill tone-${card.tone}" style="width:${pct(card.value)}%"></i></span>
          <span class="job-metric-detail">${card.detail || ''}</span>
        </button>
      `).join('')}
      ${successPct != null ? `
        <div class="board-ring-card">
          <span class="board-ring-visual">${ring(successPct)}<strong class="board-ring-num">${successPct}<small>%</small></strong></span>
          <span class="board-ring-meta">
            <span class="job-metric-label">成功率</span>
            <span class="job-metric-detail">${byKey.completed ? byKey.completed.value : 0} 成功 · ${byKey.failed ? byKey.failed.value : 0} 失败</span>
          </span>
        </div>
      ` : ''}
    </div>
  `;
  document.querySelector('#jobBoardMetrics').querySelectorAll('[data-job-filter]').forEach((element) => {
    element.addEventListener('click', () => openJobDetail(jobs, element.dataset.jobFilter, element.dataset.jobTitle));
  });

  const distribution = jobDistribution(jobs);
  const topApps = jobTopApps(jobs);
  const maxAppCount = topApps.length ? topApps[0].count : 1;
  document.querySelector('#jobBoardCharts').innerHTML = `
    <section class="job-chart-card chart-trend">
      <div class="section-head">
        <div>
          <h2 class="section-title">近 7 天趋势</h2>
          <p class="section-desc">每天新任务与完成量，点击柱状查看当天任务。</p>
        </div>
      </div>
      ${renderTrendChart(jobTrend(jobs))}
    </section>
    <section class="job-chart-card">
      <div class="section-head">
        <div>
          <h2 class="section-title">状态分布</h2>
          <p class="section-desc">点击状态行查看对应任务。</p>
        </div>
      </div>
      <div class="job-status-list">
        ${distribution.map((item) => `
          <button class="job-status-row" type="button" data-job-filter="status:${item.key}" data-job-title="${item.label}">
            <span class="job-status-label">${item.label}</span>
            <span class="job-status-track"><i class="job-status-fill tone-${item.tone}" style="width:${item.percent}%"></i></span>
            <span class="job-status-value">${item.count}<small>${item.percent}%</small></span>
          </button>
        `).join('')}
      </div>
    </section>
    <section class="job-chart-card">
      <div class="section-head">
        <div>
          <h2 class="section-title">热门应用</h2>
          <p class="section-desc">任务量最多的应用，点击查看全部任务。</p>
        </div>
      </div>
      <div class="job-app-list">
        ${topApps.length ? topApps.map((app) => `
          <button class="job-app-row" type="button" data-job-filter="app:${escapeHtml(app.name)}" data-job-title="${escapeHtml(app.name)}">
            <span class="job-app-main">
              <span class="job-app-name">${escapeHtml(app.name)}</span>
              <span class="job-app-bar"><i style="width:${Math.round((app.count / maxAppCount) * 100)}%"></i></span>
            </span>
            <span class="job-app-count">${app.count}</span>
          </button>
        `).join('') : empty('暂无应用任务')}
      </div>
    </section>
  `;
  document.querySelector('#jobBoardCharts').querySelectorAll('[data-job-filter]').forEach((element) => {
    element.addEventListener('click', () => openJobDetail(jobs, element.dataset.jobFilter, element.dataset.jobTitle));
  });
}

function renderJobBoardOrDetail(jobs) {
  if (currentJobFilter) {
    renderJobDetail(jobs, currentJobFilter.filter, currentJobFilter.title);
  } else {
    renderJobBoard(jobs);
  }
}

function filterJobsForView(jobs, filter) {
  if (filter.startsWith('status:')) {
    const key = filter.slice(7);
    return jobs.filter(JOB_STATUS_GROUPS[key] || (() => true));
  }
  if (filter.startsWith('app:')) {
    const name = filter.slice(4);
    return jobs.filter((job) => (job.app?.name || job.app?.bundleId) === name);
  }
  if (filter.startsWith('day:')) {
    const day = Number(filter.slice(4));
    const next = day + 86400000;
    return jobs.filter((job) => {
      const created = job.createdAt ? Date.parse(job.createdAt) : NaN;
      return created >= day && created < next;
    });
  }
  return jobs;
}

function openJobDetail(jobs, filter, title) {
  currentJobFilter = { filter, title };
  renderJobDetail(jobs, filter, title);
}

function renderJobDetail(jobs, filter, title) {
  const filtered = filterJobsForView(jobs, filter);
  const header = document.querySelector('#jobDetailHeader');
  if (header) {
    header.hidden = false;
    const titleEl = document.querySelector('#jobDetailTitle');
    if (titleEl) titleEl.textContent = title;
    const countEl = document.querySelector('#jobDetailCount');
    if (countEl) countEl.textContent = `${filtered.length} 个任务`;
  }
  renderJobCards(filtered);
}

function renderJobCards(jobs) {
  const root = document.querySelector('#adminJobList');
  root.innerHTML = jobs.length ? jobs.map((job) => `
    <article class="admin-device-card">
      <div class="admin-device-head">
        <div>
          <h2 class="section-title">${escapeHtml(job.app?.name || job.app?.bundleId || job.id)}</h2>
          <p class="section-desc">${escapeHtml(job.id)} · ${escapeHtml(job.deviceId || '等待动态分配')} · ${escapeHtml(formatDate(job.createdAt))}</p>
        </div>
        <span class="badge ${job.status === 'completed' ? 'success' : ['failed', 'interrupted'].includes(job.status) ? 'warning' : 'neutral'}">${escapeHtml(statusLabel(job.status))}</span>
      </div>
      <div class="admin-device-meta">
        <div><span>全局排位</span><strong>${job.queue?.position || (job.queue?.position === 0 ? '执行中' : '--')}</strong></div>
        <div><span>设备队列</span><strong>${job.deviceQueuePosition ? `第 ${escapeHtml(job.deviceQueuePosition)} 位` : (job.unfairdTaskId ? '执行中' : '--')}</strong></div>
        <div><span>预计等待</span><strong>${job.queue?.estimatedWaitSeconds ? `${Math.ceil(job.queue.estimatedWaitSeconds / 60)} 分钟` : '--'}</strong></div>
        <div><span>执行次数</span><strong>${job.attemptCount || 0} / 5</strong></div>
        <div><span>Apple ID</span><strong>${escapeHtml(job.appleAccountLabel || '--')}</strong></div>
      </div>
      ${job.error ? `<div class="alert" data-tone="warning" style="margin-top:16px">${escapeHtml(job.error)}</div>` : ''}
      <div class="admin-actions" style="margin-top:16px">
        <button class="btn btn-ghost btn-sm" type="button" data-job-detail="${escapeHtml(job.id)}">详情</button>
        ${['queued', 'running', 'downloading', 'decrypting', 'uploading'].includes(job.status) ? `<button class="btn btn-ghost btn-sm" data-job-action="cancel" data-job-id="${escapeHtml(job.id)}">取消</button>` : ''}
        ${['failed', 'interrupted', 'needs_verification', 'cancelled'].includes(job.status) ? `<button class="btn btn-primary btn-sm" data-job-action="retry" data-job-id="${escapeHtml(job.id)}">重试</button>` : ''}
        ${job.status === 'queued' ? `<button class="btn btn-ghost btn-sm" data-job-action="lock" data-job-id="${escapeHtml(job.id)}">指定设备</button>` : ''}
      </div>
    </article>
  `).join('') : empty('该板块暂无任务');
  root.querySelectorAll('[data-job-action]').forEach((button) => {
    button.addEventListener('click', () => runAdminJobAction(button.dataset.jobId, button.dataset.jobAction));
  });
  root.querySelectorAll('[data-job-detail]').forEach((button) => {
    button.addEventListener('click', () => openJobDetailModal(button.dataset.jobDetail));
  });
}

function renderJobAttempts(attempts = []) {
  if (!attempts.length) return '';
  return `
    <section class="admin-form-card" style="margin-top:16px">
      <h2>执行记录</h2>
      <div class="admin-attempts">
        ${attempts.map((attempt) => `<div>#${escapeHtml(attempt.number)} · ${escapeHtml(attempt.deviceName || attempt.deviceId)} · ${escapeHtml(statusLabel(attempt.status))}${attempt.error ? ` · ${escapeHtml(attempt.error)}` : ''}</div>`).join('')}
      </div>
    </section>
  `;
}

function renderJobLogs(logs = []) {
  if (!Array.isArray(logs) || !logs.length) return '';
  const recent = logs.slice(-40);
  return `
    <section class="admin-form-card" style="margin-top:16px">
      <h2>任务日志（最近 ${recent.length} 条）</h2>
      <pre class="admin-log-view">${recent.map((line) => escapeHtml(String(line))).join('\n')}</pre>
    </section>
  `;
}

async function openJobDetailModal(id) {
  try {
    const job = await api(`/api/admin/jobs/${encodeURIComponent(id)}`);
    openModal(`
      <h1>任务详情</h1>
      <p class="page-subtitle">${escapeHtml(job.app?.name || job.app?.bundleId || job.id)} · ${escapeHtml(statusLabel(job.status))}</p>
      <div class="admin-device-meta">
        <div><span>任务 ID</span><strong>${escapeHtml(job.id)}</strong></div>
        <div><span>设备</span><strong>${escapeHtml(job.deviceId || '等待动态分配')}</strong></div>
        <div><span>Apple ID</span><strong>${escapeHtml(job.appleAccountLabel || '--')}</strong></div>
        <div><span>创建时间</span><strong>${escapeHtml(formatDate(job.createdAt))}</strong></div>
        <div><span>更新时间</span><strong>${escapeHtml(formatDate(job.updatedAt))}</strong></div>
        <div><span>执行次数</span><strong>${Array.isArray(job.attempts) ? job.attempts.length : 0} / 5</strong></div>
      </div>
      ${job.error ? `<div class="alert" data-tone="warning" style="margin-top:16px">${escapeHtml(job.error)}</div>` : ''}
      ${renderJobAttempts(job.attempts)}
      ${renderJobLogs(job.logs)}
    `);
  } catch (error) {
    toast(error.message);
  }
}

function bindJobDetailBack() {
  const back = document.querySelector('#jobDetailBack');
  if (back) back.addEventListener('click', () => renderJobBoard(currentBoardJobs));
}

async function runAdminJobAction(id, action) {
  if (action === 'lock') {
    openModal(`
      <h1>指定任务设备</h1>
      <form id="jobLockForm" class="admin-auth-form">
        <label class="admin-field"><span>设备</span><select class="field-input field-select" name="deviceId">${devices.map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)} · ${device.online ? '在线' : '离线'}</option>`).join('')}</select></label>
        <label class="admin-field"><span>策略</span><select class="field-input field-select" name="locked"><option value="true">锁定，仅使用该设备</option><option value="false">优先使用，失败可切换</option></select></label>
        <button class="btn btn-primary" type="submit">保存</button>
      </form>
    `);
    document.querySelector('#jobLockForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await api(`/api/admin/jobs/${encodeURIComponent(id)}/lock`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: form.get('deviceId'), locked: form.get('locked') === 'true' })
      });
      closeModal();
      await loadAdminJobs();
    });
    return;
  }
  try {
    await api(`/api/admin/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
    toast(action === 'cancel' ? '取消请求已提交' : '任务已重新排队');
    await loadAdminJobs();
  } catch (error) {
    toast(error.message);
  }
}

async function loadDevices() {
  await cachedSection([
    { key: 'devices', fetcher: () => api('/api/admin/devices') },
    { key: 'admin:device-groups', fetcher: () => api('/api/admin/device-groups') },
    { key: 'admin:scheduler', fetcher: () => api('/api/admin/settings/scheduler') }
  ], (deviceRows, groupRows, scheduler) => {
    devices = deviceRows;
    groups = groupRows;
    renderSchedulerForm(scheduler);
    renderDeviceGroups();
    const root = document.querySelector('#deviceAdminList');
    root.innerHTML = devices.length ? devices.map(deviceCard).join('') : empty('尚未添加设备');
    root.querySelectorAll('[data-edit-device]').forEach((button) => {
      button.addEventListener('click', () => openDeviceForm(devices.find((item) => item.id === button.dataset.editDevice)));
    });
    root.querySelectorAll('[data-probe-device]').forEach((button) => {
      button.addEventListener('click', () => probeDevice(button.dataset.probeDevice, button));
    });
    root.querySelectorAll('[data-delete-device]').forEach((button) => {
      button.addEventListener('click', () => deleteDevice(button.dataset.deleteDevice));
    });
    root.querySelectorAll('[data-lifecycle]').forEach((select) => {
      select.addEventListener('change', () => patchDevice(select.dataset.lifecycle, { lifecycleState: select.value }));
    });
  });
}


function renderSchedulerForm(value) {
  const form = document.querySelector('#schedulerForm');
  form.innerHTML = `
    <input type="hidden" name="storageBudgetVersion" value="2">
    <div class="admin-form-grid">
      <label class="admin-field"><span>单设备最多执行次数</span><input class="field-input" type="number" min="1" max="10" name="maxAttemptsPerDevice" value="${escapeHtml(value.maxAttemptsPerDevice)}"></label>
      <label class="admin-field"><span>单任务最多使用设备数</span><input class="field-input" type="number" min="1" max="20" name="maxDevicesPerJob" value="${escapeHtml(value.maxDevicesPerJob)}"></label>
      <label class="admin-field"><span>单任务最多执行次数</span><input class="field-input" type="number" min="1" max="50" name="maxAttemptsPerJob" value="${escapeHtml(value.maxAttemptsPerJob)}"></label>
      <label class="admin-field"><span>全局最多排队任务</span><input class="field-input" type="number" min="1" max="10000" name="maxQueuedGlobal" value="${escapeHtml(value.maxQueuedGlobal || 100)}"></label>
      <label class="admin-field"><span>每用户最多排队</span><input class="field-input" type="number" min="1" max="100" name="maxQueuedPerUser" value="${escapeHtml(value.maxQueuedPerUser || 3)}"></label>
      <label class="admin-field"><span>每用户最多执行</span><input class="field-input" type="number" min="1" max="10" name="maxActivePerUser" value="${escapeHtml(value.maxActivePerUser || 1)}"></label>
      <label class="admin-field"><span>所需空间安全系数</span><input class="field-input" type="number" min="1" max="10" step="0.1" name="requiredSpaceMultiplier" value="${escapeHtml(value.requiredSpaceMultiplier)}"></label>
      <label class="admin-field"><span>最低可用空间（GB）</span><input class="field-input" type="number" min="0" step="0.1" name="minimumFreeGB" value="${escapeHtml((Number(value.minimumFreeBytes || 0) / 1024 / 1024 / 1024).toFixed(1))}"></label>
      <label class="admin-field"><span>砸壳额外开销（GB）</span><input class="field-input" type="number" min="0" step="0.1" name="storageOverheadGB" value="${escapeHtml((Number(value.storageOverheadBytes || 0) / 1024 / 1024 / 1024).toFixed(1))}"></label>
      <label class="admin-field"><span>应用扩展默认策略</span><select class="field-input field-select" name="skipExtensions"><option value="true" ${value.skipExtensions === true ? 'selected' : ''}>跳过应用扩展</option><option value="false" ${value.skipExtensions !== true ? 'selected' : ''}>尝试解密应用扩展</option></select></label>
    </div>
    <div class="admin-form-actions"><button class="btn btn-primary" type="submit">保存全局策略</button></div>
  `;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const next = formObject(new FormData(form));
    next.minimumFreeBytes = Math.round(Number(next.minimumFreeGB || 0) * 1024 * 1024 * 1024);
    next.storageOverheadBytes = Math.round(Number(next.storageOverheadGB || 0) * 1024 * 1024 * 1024);
    delete next.minimumFreeGB;
    delete next.storageOverheadGB;
    await api('/api/admin/settings/scheduler', { method: 'PATCH', body: JSON.stringify(next) });
    toast('全局调度策略已保存');
    await loadDevices();
  };
}

function renderDeviceGroups() {
  const root = document.querySelector('#deviceGroupList');
  root.innerHTML = groups.map((group) => `
    <article class="admin-device-card">
      <div class="admin-device-head">
        <div>
          <h3 class="section-title">${escapeHtml(group.name)}</h3>
          <p class="section-desc">${escapeHtml(group.priorityClass)} · 默认权重 ${group.defaultWeight}</p>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" data-edit-group="${escapeHtml(group.id)}">编辑覆盖项</button>
      </div>
    </article>
  `).join('');
  root.querySelectorAll('[data-edit-group]').forEach((button) => {
    button.addEventListener('click', () => openGroupForm(groups.find((group) => group.id === button.dataset.editGroup)));
  });
}

function openGroupForm(group) {
  const config = group.config || {};
  openModal(`
    <h1>编辑设备组：${escapeHtml(group.name)}</h1>
    <p class="page-subtitle">留空表示继承全局策略。</p>
    <form id="groupForm" class="admin-auth-form">
      <label class="admin-field"><span>默认权重</span><input class="field-input" name="defaultWeight" type="number" min="1" max="100" value="${escapeHtml(group.defaultWeight)}"></label>
      <label class="admin-field"><span>最多执行次数</span><input class="field-input" name="config.maxAttemptsPerDevice" type="number" min="1" max="10" value="${escapeHtml(config.maxAttemptsPerDevice || '')}"></label>
      <label class="admin-field"><span>应用扩展处理策略</span><select class="field-input field-select" name="config.skipExtensions"><option value="">继承全局设置</option><option value="true" ${config.skipExtensions === true ? 'selected' : ''}>跳过应用扩展</option><option value="false" ${config.skipExtensions === false ? 'selected' : ''}>尝试解密应用扩展</option></select></label>
      <button class="btn btn-primary" type="submit">保存设备组</button>
    </form>
  `);
  document.querySelector('#groupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = formObject(new FormData(event.currentTarget));
    value.config ||= {};
    if (value.config.skipExtensions === '') delete value.config.skipExtensions;
    if (value.config.maxAttemptsPerDevice === '') delete value.config.maxAttemptsPerDevice;
    await api(`/api/admin/device-groups/${encodeURIComponent(group.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(value)
    });
    closeModal();
    toast('设备组策略已保存');
    await loadDevices();
  });
}

function deviceCard(device) {
  const storage = device.freeBytes == null ? '未知' : formatBytes(device.freeBytes);
  const vnode = device.vnodeCurrent == null ? '未知' : `${device.vnodeCurrent} / ${device.vnodeLimit || '?'}`;
  const build = device.buildCommit ? String(device.buildCommit).slice(0, 12) : '待采集';
  const capabilities = deviceCapabilitySummary(device.capabilities);
  return `
    <article class="admin-device-card">
      <div class="admin-device-head">
        <div class="admin-device-title">
          <span class="status-dot ${device.online ? 'online' : device.lifecycleState === 'quarantined' ? 'warning' : ''}"></span>
          <div>
            <h2 class="section-title">${escapeHtml(device.name)}</h2>
            <p class="section-desc">${escapeHtml(device.baseUrl)}</p>
          </div>
        </div>
        <div class="admin-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-probe-device="${escapeHtml(device.id)}">检测设备状态</button>
          <button class="btn btn-ghost btn-sm" type="button" data-edit-device="${escapeHtml(device.id)}">编辑</button>
          ${currentAdmin?.role === 'super_admin' ? `<button class="btn btn-danger btn-sm" type="button" data-delete-device="${escapeHtml(device.id)}">删除</button>` : ''}
        </div>
      </div>
      <div class="admin-device-meta">
        <div><span>机型 / 系统</span><strong>${escapeHtml(device.modelName || device.machineIdentifier || '待采集')} · ${escapeHtml(device.iosVersion || '--')}</strong></div>
        <div><span>运行环境</span><strong>${escapeHtml(device.jailbreakRuntime || '--')} / ${escapeHtml(device.providerName || '--')}</strong></div>
        <div><span>可用空间</span><strong>${storage}</strong></div>
        <div><span>vnode</span><strong>${vnode}</strong></div>
        <div><span>daemon 构建</span><strong>${escapeHtml(build)}</strong></div>
        <div><span>砸壳能力</span><strong>${escapeHtml(capabilities)}</strong></div>
      </div>
      <div class="admin-device-head" style="margin-top:16px">
        <span class="badge ${device.online ? 'success' : 'neutral'}">${device.online ? '在线' : '离线'} · ${escapeHtml(device.groupName || device.priorityClass)}</span>
        <select class="field-input field-select" style="width:auto" data-lifecycle="${escapeHtml(device.id)}">
          ${[
            ['active', '启用'],
            ['draining', '排空中'],
            ['maintenance', '维护中'],
            ['quarantined', '已隔离']
          ].map(([value, label]) => `<option value="${value}" ${device.lifecycleState === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
    </article>
  `;
}

function deviceCapabilitySummary(capabilities = {}) {
  if (!capabilities || !Object.keys(capabilities).length) return '旧版节点（未上报）';
  const values = [];
  if (capabilities.externalURLDownload) values.push('远程取件');
  if (capabilities.appinstInstall) values.push('AppInst');
  if (capabilities.trollStoreInstall) values.push('TrollStore');
  if (capabilities.extensionDecryption) values.push('扩展解密');
  return values.length ? values.join(' · ') : '能力不足';
}

function openDeviceForm(device = null) {
  const groupOptions = groups.map((group) => `
    <option value="${escapeHtml(group.id)}" ${device?.groupId === group.id ? 'selected' : ''}>${escapeHtml(group.name)}</option>
  `).join('');
  openModal(`
    <h1>${device ? '编辑设备' : '添加设备'}</h1>
    <p class="page-subtitle">系统会优先自动读取设备信息；旧版节点未提供信息接口时，可手工填写 iOS 版本。</p>
    <form id="deviceForm" class="admin-auth-form">
      <label class="admin-field"><span>名称</span><input class="field-input" name="name" required value="${escapeHtml(device?.name || '')}"></label>
      <label class="admin-field"><span>节点地址</span><input class="field-input" name="baseUrl" type="url" required placeholder="http://192.168.100.122:8080" value="${escapeHtml(device?.baseUrl || '')}"></label>
      <label class="admin-field"><span>设备 API 访问密码（可选）</span><input class="field-input" name="accessToken" type="password" placeholder="${device?.accessTokenConfigured ? '已配置；留空保持不变' : '设备未启用访问密码时留空'}"></label>
      <label class="admin-field"><span>iOS 版本（自动读取失败时填写）</span><input class="field-input" name="iosVersion" inputmode="decimal" placeholder="例如 16.2" value="${escapeHtml(device?.iosVersion || '')}"></label>
      <label class="admin-field"><span>设备组</span><select class="field-input field-select" name="groupId">${groupOptions}</select></label>
      <label class="admin-field"><span>组内权重（1–100）</span><input class="field-input" name="weight" type="number" min="1" max="100" value="${device?.weight || 50}"></label>
      <label class="admin-field"><span>最多执行次数（留空继承）</span><input class="field-input" name="config.maxAttemptsPerDevice" type="number" min="1" max="10" value="${escapeHtml(device?.config?.maxAttemptsPerDevice || '')}"></label>
      <label class="admin-field"><span>应用扩展处理策略</span><select class="field-input field-select" name="config.skipExtensions"><option value="">继承设备组设置</option><option value="true" ${device?.config?.skipExtensions === true ? 'selected' : ''}>跳过应用扩展</option><option value="false" ${device?.config?.skipExtensions === false ? 'selected' : ''}>尝试解密应用扩展</option></select></label>
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">保存并探测</button></div>
    </form>
  `);
  document.querySelector('#deviceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = formObject(new FormData(event.currentTarget));
    data.weight = Number(data.weight);
    data.priorityClass = data.groupId;
    data.config ||= {};
    if (data.config.skipExtensions === '') delete data.config.skipExtensions;
    if (data.config.maxAttemptsPerDevice === '') delete data.config.maxAttemptsPerDevice;
    if (!data.accessToken) delete data.accessToken;
    try {
      await api(device ? `/api/admin/devices/${encodeURIComponent(device.id)}` : '/api/admin/devices', {
        method: device ? 'PATCH' : 'POST',
        body: JSON.stringify(data)
      });
      closeModal();
      toast('设备已保存');
      await loadDevices();
    } catch (error) {
      toast(error.message);
    }
  });
}

async function probeDevice(id, button) {
  button.disabled = true;
  try {
    await api(`/api/admin/devices/${encodeURIComponent(id)}/probe`, { method: 'POST', body: '{}' });
    toast('设备状态检测完成');
    await loadDevices();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function patchDevice(id, value) {
  try {
    await api(`/api/admin/devices/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(value)
    });
    toast('设备状态已更新');
    await loadDevices();
  } catch (error) {
    toast(error.message);
  }
}

async function deleteDevice(id) {
  const device = devices.find((item) => item.id === id);
  if (!device || !confirm(`确定删除设备“${device.name}”吗？\n\n正在执行或已锁定到该设备的任务会阻止删除。`)) return;
  try {
    await api(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('设备已删除');
    await loadDevices();
  } catch (error) {
    toast(error.message);
  }
}

async function loadAppleAccounts() {
  await cachedSection([
    { key: 'admin:apple-accounts', fetcher: () => api('/api/admin/apple-accounts') },
    { key: 'devices', fetcher: () => api('/api/admin/devices') }
  ], (accounts, deviceRows) => {
    appleAccounts = accounts;
    devices = deviceRows;
    const root = document.querySelector('#appleAccountList');
    root.innerHTML = appleAccounts.length ? appleAccounts.map((account) => `
      <article class="admin-device-card">
        <div class="admin-device-head">
          <div>
            <h2 class="section-title">${escapeHtml(account.label)}</h2>
            <p class="section-desc">${escapeHtml(account.emailMasked || '未识别邮箱')} · ${escapeHtml(storefrontLabel(account.storefront))} · 优先级 ${account.priority}</p>
          </div>
          <div class="admin-actions">
            ${account.isGlobalDefault ? '<span class="badge success">全局默认</span>' : ''}
            <button class="btn btn-ghost btn-sm" type="button" data-edit-account="${escapeHtml(account.id)}">编辑</button>
            ${currentAdmin?.role === 'super_admin' ? `<button class="btn btn-danger btn-sm" type="button" data-delete-account="${escapeHtml(account.id)}">删除</button>` : ''}
          </div>
        </div>
        <div class="admin-device-meta">
          <div><span>状态</span><strong>${account.enabled ? '启用' : '停用'}</strong></div>
          <div><span>账号地区</span><strong>${escapeHtml(storefrontLabel(account.storefront))}</strong></div>
          <div><span>设备范围</span><strong>${account.deviceIds.length ? `${account.deviceIds.length} 台指定设备` : '全部设备'}</strong></div>
          <div><span>连续失败</span><strong>${account.failureCount}</strong></div>
        </div>
        ${account.lastError ? `<div class="alert" data-tone="warning" style="margin-top:16px">${escapeHtml(account.lastError)}</div>` : ''}
      </article>
    `).join('') : empty('尚未添加 Apple ID 授权信息');
    root.querySelectorAll('[data-edit-account]').forEach((button) => {
      button.addEventListener('click', () => openAppleAccountForm(
        appleAccounts.find((account) => account.id === button.dataset.editAccount)
      ));
    });
    root.querySelectorAll('[data-delete-account]').forEach((button) => {
      button.addEventListener('click', () => deleteAppleAccount(button.dataset.deleteAccount));
    });
  });
}


async function deleteAppleAccount(id) {
  const account = appleAccounts.find((item) => item.id === id);
  if (!account || !confirm(`确定删除 Apple ID“${account.label}”吗？\n\n加密保存的账户授权信息也会一并删除，此操作不可撤销。`)) return;
  try {
    await api(`/api/admin/apple-accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Apple ID 已删除');
    await loadAppleAccounts();
  } catch (error) {
    toast(error.message);
  }
}

function openAppleAccountForm(account = null) {
  const assigned = new Set(account?.deviceIds || []);
  openModal(`
    <h1>${account ? '编辑 Apple ID' : '添加 Apple ID'}</h1>
    <p class="page-subtitle">账户授权信息将加密保存，密码和登录凭据不会在页面中再次显示。</p>
    <form id="appleAccountForm" class="admin-auth-form">
      <label class="admin-field"><span>显示名称</span><input class="field-input" name="label" required value="${escapeHtml(account?.label || '')}" placeholder="主下载账号"></label>
      <label class="admin-field"><span>账号地区</span><select class="field-input field-select" name="storefront">${storefrontOptionsHtml(account?.storefront || 'cn')}</select><small>前台选择该地区时，只会使用同地区 Apple ID。</small></label>
      <label class="admin-field"><span>优先级（1–100）</span><input class="field-input" name="priority" type="number" min="1" max="100" value="${account?.priority || 50}"></label>
      <label class="admin-field"><span>启用</span><select class="field-input field-select" name="enabled"><option value="true" ${account?.enabled !== false ? 'selected' : ''}>启用</option><option value="false" ${account?.enabled === false ? 'selected' : ''}>停用</option></select></label>
      <label class="admin-field"><span>全局默认</span><select class="field-input field-select" name="isGlobalDefault"><option value="false" ${!account?.isGlobalDefault ? 'selected' : ''}>否</option><option value="true" ${account?.isGlobalDefault ? 'selected' : ''}>是</option></select></label>
      <fieldset class="admin-field">
        <span>指定设备（不选表示所有设备可用）</span>
        <div class="admin-checkbox-list">
          ${devices.map((device) => `<label><input type="checkbox" name="deviceIds" value="${escapeHtml(device.id)}" ${assigned.has(device.id) ? 'checked' : ''}> ${escapeHtml(device.name)}</label>`).join('')}
        </div>
      </fieldset>
      ${account ? '' : '<label class="admin-field"><span>账户配置 JSON</span><textarea class="field-input" name="accountJson" rows="12" required placeholder=\'{"email":"name@example.com", ...}\'></textarea></label>'}
      ${account ? '<label class="admin-field"><span>替换账户配置 JSON（可选）</span><textarea class="field-input" name="accountJson" rows="8" placeholder="留空保持现有配置"></textarea></label>' : ''}
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">保存账户</button></div>
    </form>
  `);
  document.querySelector('#appleAccountForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const accountJson = String(form.get('accountJson') || '').trim();
    let accountData;
    if (accountJson) {
      try {
        accountData = JSON.parse(accountJson);
      } catch {
        toast('账户配置 JSON 格式不正确');
        return;
      }
    }
    const value = {
      label: form.get('label'),
      priority: Number(form.get('priority')),
      storefront: form.get('storefront') || 'cn',
      enabled: form.get('enabled') === 'true',
      isGlobalDefault: form.get('isGlobalDefault') === 'true',
      deviceIds: form.getAll('deviceIds')
    };
    if (accountData) value.account = accountData;
    try {
      await api(account ? `/api/admin/apple-accounts/${encodeURIComponent(account.id)}` : '/api/admin/apple-accounts', {
        method: account ? 'PATCH' : 'POST',
        body: JSON.stringify(value)
      });
      closeModal();
      toast('Apple ID 账户已保存');
      await loadAppleAccounts();
    } catch (error) {
      toast(error.message);
    }
  });
}

function openAppleLoginForm() {
  if (!devices.length) {
    toast('请先添加并探测一台 iPhone 设备');
    return;
  }
  openModal(`
    <h1>使用 Apple ID 登录</h1>
    <p class="page-subtitle">通过所选 iPhone 完成 Apple ID 登录。登录成功后，账户授权信息将加密保存并加入全局账户池。</p>
    <form id="appleLoginForm" class="admin-auth-form">
      <label class="admin-field"><span>登录设备</span><select class="field-input field-select" name="deviceId" required>${deviceOptions()}</select></label>
      <label class="admin-field"><span>显示名称</span><input class="field-input" name="label" value="主下载账户" required></label>
      <label class="admin-field"><span>账号地区</span><select class="field-input field-select" name="storefront">${storefrontOptionsHtml('cn')}</select><small>如果 Apple 登录结果未返回地区，则使用这里设置的地区。</small></label>
      <label class="admin-field"><span>Apple ID</span><input class="field-input" name="email" type="email" autocomplete="username" required></label>
      <label class="admin-field"><span>密码</span><input class="field-input" name="password" type="password" autocomplete="current-password" required></label>
      <label class="admin-field" id="appleVerificationField" hidden><span>双重认证验证码</span><input class="field-input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6 位验证码"></label>
      <input name="deviceIdentifier" type="hidden">
      <label class="admin-field"><span>优先级（1–100）</span><input class="field-input" name="priority" type="number" min="1" max="100" value="50"></label>
      <div id="appleLoginNotice"></div>
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">登录并保存</button></div>
    </form>
  `);
  const form = document.querySelector('#appleLoginForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const data = new FormData(form);
      const result = await api('/api/admin/apple-accounts/authenticate', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: data.get('deviceId'),
          label: data.get('label'),
          email: data.get('email'),
          password: data.get('password'),
          code: data.get('code'),
          deviceIdentifier: data.get('deviceIdentifier'),
          storefront: data.get('storefront') || 'cn',
          priority: Number(data.get('priority'))
        })
      });
      if (result.codeRequired) {
        form.elements.deviceIdentifier.value = result.deviceIdentifier;
        const verification = document.querySelector('#appleVerificationField');
        verification.hidden = false;
        verification.querySelector('input').required = true;
        document.querySelector('#appleLoginNotice').innerHTML = '<div class="alert" data-tone="warning">已触发双重认证，请输入本次登录收到的 6 位验证码。请勿切换设备或关闭窗口。</div>';
        submit.textContent = '验证并保存';
        verification.querySelector('input').focus();
        toast('请输入双重认证验证码');
        return;
      }
      closeModal();
      toast('Apple ID 已登录并同步到全局账户池');
      await loadAppleAccounts();
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

function openSyncAppleAccountForm() {
  if (!devices.length) {
    toast('请先添加并探测一台 iPhone 设备');
    return;
  }
  openModal(`
    <h1>同步设备账户</h1>
    <p class="page-subtitle">读取所选 iPhone 当前默认 Apple ID 授权信息，并保存到全局账户池。</p>
    <form id="syncAppleAccountForm" class="admin-auth-form">
      <label class="admin-field"><span>来源设备</span><select class="field-input field-select" name="deviceId" required>${deviceOptions()}</select></label>
      <label class="admin-field"><span>显示名称</span><input class="field-input" name="label" value="设备同步账户" required></label>
      <label class="admin-field"><span>默认账号地区</span><select class="field-input field-select" name="storefront">${storefrontOptionsHtml('cn')}</select><small>设备未返回地区时使用；多个账号可同步后分别编辑。</small></label>
      <label class="admin-field"><span>优先级（1–100）</span><input class="field-input" name="priority" type="number" min="1" max="100" value="50"></label>
      <div class="alert" data-tone="warning">该操作会传输完整账户授权信息。请仅在受信任的网络环境中执行，并确保设备与平台均已启用访问保护。</div>
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">同步到总后台</button></div>
    </form>
  `);
  const form = document.querySelector('#syncAppleAccountForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const data = new FormData(form);
      const result = await api('/api/admin/apple-accounts/sync-device', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: data.get('deviceId'),
          label: data.get('label'),
          storefront: data.get('storefront') || 'cn',
          priority: Number(data.get('priority'))
        })
      });
      closeModal();
      toast(`已同步 ${result.count || result.accounts?.length || 0} 个账户，已加入全局账户池`);
      await loadAppleAccounts();
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

function deviceOptions() {
  return devices.map((device) => `
    <option value="${escapeHtml(device.id)}">${escapeHtml(device.name)} · ${escapeHtml(device.modelName || device.machineIdentifier || '型号待采集')} · ${device.online ? '在线' : '离线'}</option>
  `).join('');
}

function storefrontLabel(value) {
  return STOREFRONTS.find((item) => item.code === String(value || 'cn'))?.label || '中国大陆';
}

function storefrontOptionsHtml(selected = 'cn') {
  const active = String(selected || 'cn');
  return STOREFRONTS.map((item) =>
    `<option value="${escapeHtml(item.code)}" ${item.code === active ? 'selected' : ''}>${escapeHtml(item.label)}</option>`
  ).join('');
}

async function loadCardBatches() {
  await cachedSection([
    { key: 'admin:cards', fetcher: () => Promise.all([
      api('/api/admin/cards/batches'),
      api('/api/admin/users/credits'),
      api('/api/admin/settings/cards')
    ]) }
  ], ([batches, users, purchase]) => {
    const root = document.querySelector('#cardBatchList');
    root.innerHTML = batches.length ? batches.map((batch) => `
      <article class="admin-device-card">
        <div class="admin-device-head">
          <div>
            <h2 class="section-title">${escapeHtml(batch.name)}</h2>
            <p class="section-desc">${escapeHtml(batch.prefix)} · 每张 ${batch.creditPerCard} 次 · 共 ${batch.quantity} 张</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-view-cards="${escapeHtml(batch.id)}">查看兑换码</button>
        </div>
        <div class="admin-device-meta">
          <div><span>可用</span><strong>${batch.availableCount}</strong></div>
          <div><span>已兑换</span><strong>${batch.redeemedCount}</strong></div>
          <div><span>有效期</span><strong>${batch.expiresAt ? formatDate(batch.expiresAt) : '长期有效'}</strong></div>
          <div><span>状态</span><strong>${batch.enabled ? '启用' : '停用'}</strong></div>
        </div>
      </article>
    `).join('') : empty('尚未创建兑换码');
    root.querySelectorAll('[data-view-cards]').forEach((button) => {
      button.addEventListener('click', () => revealCards(button.dataset.viewCards));
    });
    document.querySelector('#userCreditList').innerHTML = users.length ? `
      <table class="admin-table">
        <thead><tr><th>OpenID</th><th>余额</th><th>状态</th><th>更新时间</th></tr></thead>
        <tbody>${users.map((user) => `<tr><td><code>${escapeHtml(user.openid)}</code></td><td>${user.balance} 次</td><td>${user.frozen ? '冻结' : '正常'}</td><td>${escapeHtml(formatDate(user.updatedAt))}</td></tr>`).join('')}</tbody>
      </table>
    ` : empty('暂无用户额度记录');
    renderCardPurchaseSettings(purchase);
  });
}


function renderCardPurchaseSettings(settings = {}) {
  const form = document.querySelector('#cardPurchaseForm');
  if (!form) return;
  form.innerHTML = `
    <section class="admin-form-card">
      <h2>服务购买入口</h2>
      <p class="page-subtitle">用户点击“购买兑换码”时打开此链接；留空时只显示下方提示文案。</p>
      <div class="admin-form-grid">
        <label class="admin-field full">
          <span>购买链接</span>
          <input class="field-input" type="url" name="purchaseUrl" value="${escapeHtml(settings.purchaseUrl || '')}" placeholder="https://example.com/buy">
        </label>
        <label class="admin-field full">
          <span>购买提示</span>
          <textarea class="field-input" name="purchaseHint" rows="3" maxlength="300" placeholder="请在微信公众号回复“购买兑换码”获取购买方式">${escapeHtml(settings.purchaseHint || '')}</textarea>
        </label>
      </div>
    </section>
    <div class="admin-form-actions"><button class="btn btn-primary" type="submit">保存购买设置</button></div>
  `;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    try {
      const saved = await api('/api/admin/settings/cards', {
        method: 'PATCH',
        body: JSON.stringify(values)
      });
      toast('服务购买设置已保存');
      renderCardPurchaseSettings(saved);
    } catch (error) {
      toast(error.message);
    }
  };
}

function openCardBatchForm() {
  openModal(`
    <h1>批量创建兑换码</h1>
    <p class="page-subtitle">兑换码会以明文保存，查看和导出操作将记录在安全审计中。</p>
    <form id="cardBatchForm" class="admin-auth-form">
      <label class="admin-field"><span>批次名称</span><input class="field-input" name="name" required></label>
      <label class="admin-field"><span>生成数量</span><input class="field-input" name="quantity" type="number" min="1" max="10000" value="10" required></label>
      <label class="admin-field"><span>每张可用次数</span><input class="field-input" name="creditPerCard" type="number" min="1" value="5" required></label>
      <label class="admin-field"><span>兑换码前缀（可选）</span><input class="field-input" name="prefix" placeholder="91IOS"></label>
      <label class="admin-field"><span>有效期（可选）</span><input class="field-input" name="expiresAt" type="datetime-local"></label>
      <label class="admin-field"><span>渠道</span><input class="field-input" name="channel"></label>
      <label class="admin-field"><span>备注</span><textarea class="field-input" name="notes" rows="3"></textarea></label>
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">生成</button></div>
    </form>
  `);
  document.querySelector('#cardBatchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = Object.fromEntries(new FormData(event.currentTarget));
    value.quantity = Number(value.quantity);
    value.creditPerCard = Number(value.creditPerCard);
    value.expiresAt = value.expiresAt ? new Date(value.expiresAt).toISOString() : null;
    const batch = await api('/api/admin/cards/batches', { method: 'POST', body: JSON.stringify(value) });
    showCodes(batch.cards, `${batch.prefix}-${batch.id.slice(0, 6)}`);
    await loadCardBatches();
  });
}

async function revealCards(batchId) {
  try {
    const cards = await api(`/api/admin/cards/batches/${encodeURIComponent(batchId)}/cards`);
    showCodes(cards.map((card) => `${card.code}${card.redeemedAt ? `  [已兑换 ${card.redeemedBy || ''}]` : ''}`), batchId);
  } catch (error) {
    toast(error.message);
  }
}

function showCodes(codes, fileName) {
  openModal(`
    <h1>兑换码明细</h1>
    <p class="page-subtitle">共 ${codes.length} 张。该查看操作已写入审计日志。</p>
    <div class="admin-actions" style="margin:16px 0">
      <button id="copyCards" class="btn btn-primary" type="button">复制全部</button>
      <button id="downloadCards" class="btn btn-ghost" type="button">导出 TXT</button>
    </div>
    <div class="admin-card-codes">${escapeHtml(codes.join('\n'))}</div>
  `);
  document.querySelector('#copyCards').addEventListener('click', async () => {
    await navigator.clipboard.writeText(codes.join('\n'));
    toast('兑换码已复制');
  });
  document.querySelector('#downloadCards').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([codes.join('\n')], { type: 'text/plain;charset=utf-8' }));
    link.download = `91ios-dump-codes-${fileName}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

async function loadStorage() {
  await cachedSection([
    { key: 'admin:storage', fetcher: () => api('/api/admin/settings/storage') }
  ], (storage) => {
    const form = document.querySelector('#storageForm');
    form.innerHTML = `
      <section class="admin-form-card">
        <h2>平台文件策略</h2>
        <div class="admin-form-grid">
          <label class="admin-field"><span>分发方式</span><select class="field-input field-select" name="mode"><option value="local" ${storage.mode !== 'cos' ? 'selected' : ''}>本地</option><option value="cos" ${storage.mode === 'cos' ? 'selected' : ''}>腾讯云 COS</option></select></label>
          <label class="admin-field"><span>文件保留分钟</span><input class="field-input" type="number" min="1" name="artifactRetentionMinutes" value="${escapeHtml(storage.artifactRetentionMinutes || 1440)}"></label>
          <label class="admin-field full"><span>本地文件目录</span><input class="field-input" name="localDir" value="${escapeHtml(storage.localDir || './data/artifacts')}"></label>
          <label class="admin-field full"><span>公网基础地址</span><input class="field-input" type="url" name="publicBaseUrl" value="${escapeHtml(storage.publicBaseUrl || '')}" placeholder="https://dump.dkapps.cn"></label>
          <label class="admin-field full"><span>iPhone 局域网取件地址</span><input class="field-input" type="url" name="internalBaseUrl" value="${escapeHtml(storage.internalBaseUrl || '')}" placeholder="http://192.168.100.1:8080"></label>
        </div>
      </section>
    ` + cosForm('主存储服务（COS）', 'cos', storage.cos || {}, true)
      + cosForm('备用存储服务（COS，可选）', 'fallbackCos', storage.fallbackCos || {}, false)
      + '<div class="admin-form-actions"><button class="btn btn-primary" type="submit">保存存储配置</button></div>';
    form.onsubmit = async (event) => {
      event.preventDefault();
      const value = formObject(new FormData(form));
      await api('/api/admin/settings/storage', { method: 'PATCH', body: JSON.stringify(value) });
      toast('存储配置已保存');
      await loadStorage();
    };
    form.querySelectorAll('[data-test-cos]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api('/api/admin/settings/storage/test', {
            method: 'POST',
            body: JSON.stringify({ configKey: button.dataset.testCos })
          });
          toast(`${button.dataset.testCos === 'cos' ? '主' : '备用'} COS 上传与删除测试通过`);
        } catch (error) {
          toast(error.message);
        } finally {
          button.disabled = false;
        }
      });
    });
  });
}

function cosForm(title, name, cos, required) {
  return `
    <section class="admin-form-card">
      <h2>${title}</h2>
      <p>${required ? '任务文件默认上传到主存储服务。' : '主存储服务连续失败时自动启用；无需强制配置。'}</p>
      <div class="admin-form-grid">
        <label class="admin-field"><span>启用</span><select class="field-input field-select" name="${name}.enabled"><option value="false" ${!cos.enabled ? 'selected' : ''}>关闭</option><option value="true" ${cos.enabled ? 'selected' : ''}>开启</option></select></label>
        <label class="admin-field"><span>Region</span><input class="field-input" name="${name}.region" value="${escapeHtml(cos.region || '')}" placeholder="ap-shanghai"></label>
        <label class="admin-field"><span>Bucket</span><input class="field-input" name="${name}.bucket" value="${escapeHtml(cos.bucket || '')}"></label>
        <label class="admin-field"><span>对象前缀</span><input class="field-input" name="${name}.prefix" value="${escapeHtml(cos.prefix || 'ipa')}"></label>
        <label class="admin-field full"><span>自定义访问域名</span><input class="field-input" name="${name}.publicDomain" value="${escapeHtml(cos.publicDomain || '')}" placeholder="https://cos.example.com"></label>
        <label class="admin-field"><span>SecretId</span><input class="field-input" type="password" name="${name}.secretId" value="${escapeHtml(cos.secretId || '')}" placeholder="${cos.secretConfigured ? '已配置；留空保持不变' : ''}"></label>
        <label class="admin-field"><span>SecretKey</span><input class="field-input" type="password" name="${name}.secretKey" value="${escapeHtml(cos.secretKey || '')}" placeholder="${cos.secretConfigured ? '已配置；留空保持不变' : ''}"></label>
        <label class="admin-field"><span>文件保留小时</span><input class="field-input" type="number" min="1" name="${name}.retentionHours" value="${escapeHtml(cos.retentionHours || 24)}"></label>
        <label class="admin-field"><span>签名链接分钟</span><input class="field-input" type="number" min="1" name="${name}.signedUrlMinutes" value="${escapeHtml(cos.signedUrlMinutes || 15)}"></label>
      </div>
      <div class="admin-form-actions"><button class="btn btn-ghost" type="button" data-test-cos="${name}">测试上传并删除</button></div>
    </section>
  `;
}

async function loadNotifications() {
  await cachedSection([
    { key: 'admin:notifications', fetcher: () => Promise.all([
      api('/api/admin/settings/notifications'),
      api('/api/admin/settings/wechat-gateway')
    ]) }
  ], ([value, gateway]) => {
    const robot = value.wecomRobots?.[0] || {};
    const form = document.querySelector('#notificationForm');
    form.innerHTML = `
      <section class="admin-form-card">
        <h2>微信公众号业务网关</h2>
        <p>公众号密钥只保存在公众号管理平台；这里填写业务应用的 HMAC 凭据。</p>
        <div class="admin-form-grid">
          <label class="admin-field full"><span>网关地址</span><input class="field-input" name="gateway.baseUrl" value="${escapeHtml(gateway.baseUrl || '')}" placeholder="https://wx.example.com"></label>
          <label class="admin-field"><span>客户端标识</span><input class="field-input" name="gateway.clientId" value="${escapeHtml(gateway.clientId || '')}" placeholder="91ios-dump"></label>
          <label class="admin-field"><span>公众号 AppID</span><input class="field-input" name="gateway.appId" value="${escapeHtml(gateway.appId || '')}"></label>
          <label class="admin-field full"><span>Client Secret</span><input class="field-input" type="password" name="gateway.clientSecret" value="" placeholder="${gateway.secretConfigured ? '已配置；留空保持不变' : '从公众号管理平台创建或轮换'}"></label>
          <label class="admin-field"><span>请求超时（毫秒）</span><input class="field-input" type="number" min="1000" name="gateway.timeoutMs" value="${escapeHtml(gateway.timeoutMs || 10000)}"></label>
        </div>
        <div class="admin-form-actions"><button id="testWechatGateway" class="btn btn-ghost" type="button">测试网关连接</button></div>
      </section>
      <section class="admin-form-card">
        <h2>企业微信机器人</h2>
        <p>用于设备离线、隔离、空间、Apple ID、COS 和备份告警。</p>
        <div class="admin-form-grid">
          <input type="hidden" name="wecomRobots.0.id" value="${escapeHtml(robot.id || 'default')}">
          <label class="admin-field"><span>机器人名称</span><input class="field-input" name="wecomRobots.0.name" value="${escapeHtml(robot.name || '运维告警')}"></label>
          <label class="admin-field"><span>启用</span><select class="field-input field-select" name="wecomRobots.0.enabled"><option value="true" ${robot.enabled !== false ? 'selected' : ''}>开启</option><option value="false" ${robot.enabled === false ? 'selected' : ''}>关闭</option></select></label>
          <label class="admin-field full"><span>Webhook URL</span><input class="field-input" type="password" name="wecomRobots.0.webhook" value="${escapeHtml(robot.webhook || '')}" placeholder="${robot.webhookConfigured ? '已配置；留空保持不变' : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'}"></label>
          <label class="admin-field"><span>最低告警级别</span><select class="field-input field-select" name="wecomRobots.0.minimumSeverity"><option value="warning">Warning</option><option value="critical" ${robot.minimumSeverity === 'critical' ? 'selected' : ''}>Critical</option></select></label>
          <label class="admin-field"><span>合并窗口（分钟）</span><input class="field-input" type="number" min="1" name="wecomRobots.0.dedupMinutes" value="${escapeHtml(robot.dedupMinutes || 30)}"></label>
        </div>
      </section>
      <div class="admin-form-actions">
        <button class="btn btn-primary" type="submit">保存通知配置</button>
        <button id="testNotification" class="btn btn-ghost" type="button">发送测试告警</button>
      </div>
    `;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const next = formObject(new FormData(form));
      await Promise.all([
        api('/api/admin/settings/notifications', {
          method: 'PATCH',
          body: JSON.stringify({ wecomRobots: next.wecomRobots || [] })
        }),
        api('/api/admin/settings/wechat-gateway', {
          method: 'PATCH',
          body: JSON.stringify(next.gateway || {})
        })
      ]);
      toast('通知配置已保存');
      await loadNotifications();
    };
    form.querySelector('#testNotification').addEventListener('click', async () => {
      try {
        await api('/api/admin/settings/notifications/test', { method: 'POST', body: '{}' });
        toast('测试告警已发送');
      } catch (error) {
        toast(error.message);
      }
    });
    form.querySelector('#testWechatGateway').addEventListener('click', async () => {
      try {
        await api('/api/admin/settings/wechat-gateway/test', { method: 'POST', body: '{}' });
        toast('公众号业务网关连接正常');
      } catch (error) {
        toast(`网关测试失败：${error.message}`);
      }
    });
  });
}

let auditOffset = 0;
let auditTotal = 0;

function auditRow(log) {
  return `
    <tr>
      <td>${escapeHtml(formatDate(log.createdAt))}</td>
      <td>${escapeHtml(log.actorUsername || '系统')}</td>
      <td>${auditActionBadge(log.action)}</td>
      <td>${escapeHtml(log.summary)}</td>
      <td>${escapeHtml([log.targetType, log.targetId].filter(Boolean).join(': '))}</td>
    </tr>
  `;
}

function auditActionBadge(action) {
  const a = String(action || '').toLowerCase();
  let tone = 'neutral';
  if (/login|logout|auth/.test(a)) tone = 'info';
  else if (/create|add|generate|import/.test(a)) tone = 'success';
  else if (/update|edit|patch|set|save|config/.test(a)) tone = 'accent';
  else if (/delete|remove|revoke|clear/.test(a)) tone = 'danger';
  return `<span class="badge ${tone}">${escapeHtml(action)}</span>`;
}

function renderAuditTable(logs, root) {
  root.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>内容</th><th>目标</th></tr></thead>
      <tbody>${logs.map(auditRow).join('')}</tbody>
    </table>
  `;
  updateAuditLoadMore(root);
}

function updateAuditLoadMore(root) {
  const hasMore = auditTotal > auditOffset;
  let button = root.querySelector('#auditLoadMore');
  if (!hasMore) {
    if (button) button.remove();
    return;
  }
  if (!button) {
    button = document.createElement('button');
    button.id = 'auditLoadMore';
    button.className = 'btn btn-ghost btn-sm';
    button.type = 'button';
    button.style.marginTop = '12px';
    button.addEventListener('click', () => loadMoreAudit());
    root.appendChild(button);
  }
  button.textContent = `加载更多（已显示 ${auditOffset} / ${auditTotal}）`;
  button.disabled = false;
}

async function loadMoreAudit() {
  try {
    const page = await api(`/api/admin/audit?limit=100&offset=${auditOffset}`);
    const logs = Array.isArray(page) ? page : (page.items || []);
    auditTotal = Array.isArray(page) ? auditOffset + logs.length : (page.total ?? auditOffset + logs.length);
    const root = document.querySelector('#auditList');
    const tbody = root.querySelector('tbody');
    if (tbody) tbody.insertAdjacentHTML('beforeend', logs.map(auditRow).join(''));
    auditOffset += logs.length;
    updateAuditLoadMore(root);
  } catch (error) {
    toast(error.message);
  }
}

async function loadAudit() {
  await cachedSection([
    { key: 'admin:audit', fetcher: () => api('/api/admin/audit?limit=100&offset=0') }
  ], (page) => {
    const logs = Array.isArray(page) ? page : (page.items || []);
    auditTotal = Array.isArray(page) ? logs.length : (page.total ?? logs.length);
    auditOffset = logs.length;
    renderAuditTable(logs, document.querySelector('#auditList'));
  });
}

async function loadAdmins() {
  await cachedSection([
    { key: 'admin:admins', fetcher: () => api('/api/admin/admins') }
  ], (admins) => {
    const root = document.querySelector('#adminUserList');
    root.innerHTML = admins.map((admin) => `
      <article class="admin-device-card">
        <div class="admin-device-head">
          <div>
            <h2 class="section-title">${escapeHtml(admin.username)}</h2>
            <p class="section-desc">${escapeHtml(roleLabel(admin.role))} · TOTP ${admin.totpEnabled ? '已启用' : '未启用'}</p>
          </div>
          <select class="field-input field-select" style="width:auto" data-admin-role="${escapeHtml(admin.id)}">
            ${[['super_admin', '超级管理员'], ['operator', '操作员'], ['auditor', '审计员']].map(([value, label]) => `<option value="${value}" ${admin.role === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </article>
    `).join('');
    root.querySelectorAll('[data-admin-role]').forEach((select) => {
      select.addEventListener('change', async () => {
        await api(`/api/admin/admins/${encodeURIComponent(select.dataset.adminRole)}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: select.value })
        });
        toast('管理员角色已更新');
      });
    });
  });
}

function openAdminForm() {
  openModal(`
    <h1>添加管理员</h1>
    <form id="newAdminForm" class="admin-auth-form">
      <label class="admin-field"><span>用户名</span><input class="field-input" name="username" required minlength="3"></label>
      <label class="admin-field"><span>初始密码（至少 12 位）</span><input class="field-input" type="password" name="password" required minlength="12"></label>
      <label class="admin-field"><span>角色</span><select class="field-input field-select" name="role"><option value="operator">操作员</option><option value="auditor">审计员</option><option value="super_admin">超级管理员</option></select></label>
      <button class="btn btn-primary" type="submit">创建并生成 TOTP</button>
    </form>
  `);
  document.querySelector('#newAdminForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api('/api/admin/admins', { method: 'POST', body: JSON.stringify(value) });
      openModal(`
        <h1>保存 TOTP 密钥</h1>
        <p class="page-subtitle">请立即交给 ${escapeHtml(result.admin.username)} 添加到验证器；此后登录需要密码和 6 位验证码。</p>
        <div class="admin-secret">${escapeHtml(result.secret)}</div>
        <div class="admin-secret">${escapeHtml(result.otpauthUrl)}</div>
        <button class="btn btn-primary" type="button" data-close-modal>完成</button>
      `);
      modalContent.querySelector('[data-close-modal]').addEventListener('click', closeModal);
      await loadAdmins();
    } catch (error) {
      toast(error.message);
    }
  });
}

const sectionRefreshDebounce = new Map();

function debounceSectionRefresh(eventName, fn, delayMs = 800) {
  clearTimeout(sectionRefreshDebounce.get(eventName));
  sectionRefreshDebounce.set(eventName, setTimeout(() => {
    sectionRefreshDebounce.delete(eventName);
    fn();
  }, delayMs));
}

function invalidateSectionSettingsCache() {
  invalidateCache('admin:storage');
  invalidateCache('admin:notifications');
  invalidateCache('admin:scheduler');
  invalidateCache('admin:device-groups');
}

function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/admin/events');
  for (const eventName of ['devices.changed', 'devices.snapshot', 'jobs.changed', 'apple-accounts.changed', 'cards.changed', 'settings.changed']) {
    eventSource.addEventListener(eventName, () => {
      if (eventName === 'jobs.changed') invalidateCache('admin:jobs');
      if (eventName === 'apple-accounts.changed') invalidateCache('admin:apple-accounts');
      if (eventName === 'cards.changed') invalidateCache('admin:cards');
      if (eventName === 'settings.changed') invalidateSectionSettingsCache();
      if (eventName.startsWith('devices')) invalidateCache('devices');
      debounceSectionRefresh(eventName, () => {
        const active = document.querySelector('#adminNav button.active')?.dataset.section;
        if (active === 'overview') loadOverview();
        if (active === 'jobs' && eventName === 'jobs.changed') loadAdminJobs();
        if (active === 'devices' && eventName.startsWith('devices')) loadDevices();
        if (active === 'accounts' && eventName === 'apple-accounts.changed') loadAppleAccounts();
        if (active === 'cards' && eventName === 'cards.changed') loadCardBatches();
      });
    });
  }
}

function deviceTable(rows) {
  return `
    <table class="admin-table">
      <thead><tr><th>设备</th><th>状态</th><th>机型 / iOS</th><th>设备组</th><th>可用空间</th><th>最后在线</th></tr></thead>
      <tbody>${rows.map((device) => `
        <tr>
          <td><strong>${escapeHtml(device.name)}</strong><br><small>${escapeHtml(device.baseUrl)}</small></td>
          <td><span class="badge ${device.online ? 'success' : 'neutral'}">${device.online ? '在线' : device.lifecycleState}</span></td>
          <td>${escapeHtml(device.modelName || device.machineIdentifier || '--')} / ${escapeHtml(device.iosVersion || '--')}</td>
          <td>${escapeHtml(device.groupName || '--')} · ${device.weight}</td>
          <td>${device.freeBytes == null ? '--' : formatBytes(device.freeBytes)}</td>
          <td>${device.lastSeenAt ? escapeHtml(formatDate(device.lastSeenAt)) : '--'}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).error || message;
    } catch {}
    if (response.status === 401 && currentAdmin) {
      currentAdmin = null;
      showLogin();
    }
    throw new Error(message);
  }
  return response.json();
}

function openModal(html) {
  modalContent.innerHTML = html;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modal.hidden = true;
  modalContent.innerHTML = '';
  document.body.style.overflow = '';
}

function toast(message) {
  toastRoot.textContent = message;
  toastRoot.hidden = false;
  clearTimeout(toastRoot._timer);
  toastRoot._timer = setTimeout(() => { toastRoot.hidden = true; }, 3200);
}

function formObject(formData) {
  const root = {};
  for (const [path, rawValue] of formData) {
    const keys = path.split('.');
    let value = rawValue;
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    if (/^\d+$/.test(value)) value = Number(value);
    let current = root;
    for (let index = 0; index < keys.length - 1; index += 1) {
      const key = keys[index];
      const nextKey = keys[index + 1];
      if (current[key] == null) current[key] = /^\d+$/.test(nextKey) ? [] : {};
      current = current[key];
    }
    current[keys.at(-1)] = value;
  }
  return root;
}

function roleLabel(role) {
  return {
    super_admin: '超级管理员',
    operator: '运营管理员',
    auditor: '只读审计员'
  }[role] || role;
}

function statusLabel(status) {
  return {
    queued: '等待处理',
    pending: '等待处理',
    running: '正在处理',
    downloading: '正在获取应用',
    decrypting: '正在解密',
    uploading: '正在生成下载文件',
    completed: '已完成',
    failed: '处理失败',
    interrupted: '处理已中断',
    needs_verification: '等待身份验证',
    cancelled: '已取消',
    active: '启用',
    disabled: '停用'
  }[status] || status || '--';
}

function empty(text) {
  return `<div class="empty-state muted">${escapeHtml(text)}</div>`;
}

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = number;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
