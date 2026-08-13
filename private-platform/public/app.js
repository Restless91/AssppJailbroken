let currentUser = null;
let loginPollTimer = null;

const pageViews = Array.from(document.querySelectorAll('[data-page]'));
const routeLinks = Array.from(document.querySelectorAll('[data-route]'));
const navLinks = Array.from(document.querySelectorAll('[data-nav]'));

const appGrid = document.querySelector('#appGrid');
const jobList = document.querySelector('#jobList');
const deviceList = document.querySelector('#deviceList');
const refreshButton = document.querySelector('#refreshButton');
const syncAccountButton = document.querySelector('#syncAccountButton');
const refreshJobsButton = document.querySelector('#refreshJobsButton');
const reloadTopAppsButton = document.querySelector('#reloadTopAppsButton');
const forceExtensionToggle = document.querySelector('#forceExtensionToggle');
const searchForm = document.querySelector('#searchForm');
const searchInput = document.querySelector('#searchInput');
const searchCountry = document.querySelector('#searchCountry');
const searchEntity = document.querySelector('#searchEntity');
const searchButton = document.querySelector('#searchButton');
const searchPageForm = document.querySelector('#searchPageForm');
const searchPageInput = document.querySelector('#searchPageInput');
const searchPageCountry = document.querySelector('#searchPageCountry');
const searchPageEntity = document.querySelector('#searchPageEntity');
const searchResults = document.querySelector('#searchResults');
const searchResultSubtitle = document.querySelector('#searchResultSubtitle');
const jobFilters = document.querySelector('#jobFilters');
const deviceSummary = document.querySelector('#deviceSummary');
const metricOnline = document.querySelector('#metricOnline');
const metricActive = document.querySelector('#metricActive');
const metricOnlineTasks = document.querySelector('#metricOnlineTasks');
const metricQueued = document.querySelector('#metricQueued');
const metricCompleted = document.querySelector('#metricCompleted');
const metricFailed = document.querySelector('#metricFailed');
const creditButton = document.querySelector('#creditButton');
const creditButtonMobile = document.querySelector('#creditButtonMobile');
const creditModal = document.querySelector('#creditModal');
const creditModalClose = document.querySelector('#creditModalClose');
const redeemCardForm = document.querySelector('#redeemCardForm');
const redeemCardInput = document.querySelector('#redeemCardInput');
const redeemCardButton = document.querySelector('#redeemCardButton');
const redeemCardMessage = document.querySelector('#redeemCardMessage');
const purchaseCardButton = document.querySelector('#purchaseCardButton');
const creditPurchaseHint = document.querySelector('#creditPurchaseHint');

let cachedTopApps = [];
let cachedDevices = [];
let cachedJobs = [];
let cachedSearchResults = [];
let jobFilter = 'all';
let versionModalState = null;
const versionMetaCache = new Map();
const VERSION_PROVIDERS = ['auto', 'timbrd', 'agzy', 'bilin', 'apple'];
const VERSION_PROVIDER_LABELS = {
  auto: '自动',
  timbrd: 'Timbrd',
  agzy: 'Agzy',
  bilin: 'Bilin',
  apple: 'Apple'
};
const VERSION_METADATA_PRELOAD_LIMIT = 24;
let platformCapabilities = {
  browserAccountSync: { enabled: true, reason: '' },
  cards: { purchaseUrl: '', purchaseHint: '' }
};

creditButton?.addEventListener('click', () => openCreditModal());
creditButtonMobile?.addEventListener('click', () => openCreditModal());
creditModalClose?.addEventListener('click', () => closeCreditModal());
creditModal?.addEventListener('click', (event) => {
  if (event.target === creditModal) closeCreditModal();
});
redeemCardForm?.addEventListener('submit', (event) => redeemCard(event));
purchaseCardButton?.addEventListener('click', () => {
  const url = platformCapabilities.cards?.purchaseUrl || '';
  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  toast(platformCapabilities.cards?.purchaseHint || '请在微信公众号回复“购买兑换码”获取购买方式');
});

routeLinks.forEach((link) => {
  link.addEventListener('click', (event) => {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http')) return;
    event.preventDefault();
    navigate(href);
  });
});

window.addEventListener('popstate', () => showRoute(location.pathname + location.search + location.hash));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideLoginOverlay();
});
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-login-trigger]');
  if (!trigger) return;
  event.preventDefault();
  void ensureAuthenticated();
});
refreshButton?.addEventListener('click', () => refreshHome({ manual: true }));
syncAccountButton?.addEventListener('click', () => syncBrowserAccount());
refreshJobsButton?.addEventListener('click', () => loadJobs(true));
reloadTopAppsButton?.addEventListener('click', () => loadTopApps(true));
searchForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  submitSearch({ input: searchInput, country: searchCountry, entity: searchEntity });
});
searchPageForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  submitSearch({ input: searchPageInput, country: searchPageCountry, entity: searchPageEntity });
});

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function ensureAuthenticated({ prompt = true } = {}) {
  const me = await api('/api/auth/me').catch(() => ({ authenticated: false, wechat: { enabled: false } }));
  if (me.authenticated) {
    currentUser = me;
    hideLoginOverlay();
    renderCreditBalance();
    return true;
  }
  currentUser = { authenticated: false, type: 'anonymous' };
  renderCreditBalance();
  renderAnonymousState();
  if (prompt) await showLoginOverlay(me.wechat || platformCapabilities.wechat || { enabled: false });
  return false;
}

async function showLoginOverlay(wechat) {
  let overlay = document.querySelector('#loginOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loginOverlay';
    overlay.className = 'login-overlay';
    document.body.appendChild(overlay);
  }
  overlay.hidden = false;
  overlay.onclick = (event) => {
    if (event.target === overlay) hideLoginOverlay();
  };
  overlay.innerHTML = `
    <div class="login-card">
      <button class="icon-button login-close" type="button" data-close-login aria-label="关闭登录窗口">×</button>
      <p class="eyebrow">Wechat Login</p>
      <h1>使用微信公众号登录</h1>
      <p class="login-copy">扫码关注公众号并按提示完成登录。任务完成后，公众号会推送 IPA 下载通知。</p>
      <div id="wechatQrBox" class="wechat-qr-box">
        ${wechat.enabled ? '<div class="empty-state muted">正在生成登录二维码...</div>' : '<div class="warning-box">微信公众号登录暂不可用，请稍后重试或联系管理员。</div>'}
      </div>
    </div>
  `;
  overlay.querySelector('[data-close-login]')?.addEventListener('click', () => hideLoginOverlay());
  if (wechat.enabled) {
    await startWechatLogin(overlay.querySelector('#wechatQrBox'));
  }
}

function hideLoginOverlay() {
  const overlay = document.querySelector('#loginOverlay');
  if (overlay) overlay.hidden = true;
  if (loginPollTimer) clearInterval(loginPollTimer);
  loginPollTimer = null;
}

async function startWechatLogin(box) {
  try {
    const browserNonce = crypto.randomUUID();
    const login = await api('/api/wechat/login/qrcode', {
      method: 'POST',
      body: JSON.stringify({ browserNonce })
    });
    const qrCodeUrl = login.qrCodeUrl || login.qrcodeUrl || '';
    const keywordMode = login.mode === 'keyword' || Boolean(login.loginCode);
    box.innerHTML = keywordMode ? `
      ${qrCodeUrl ? `<img class="wechat-qr" src="${escapeHtml(qrCodeUrl)}" alt="微信公众号二维码" />` : ''}
      <p class="muted">扫码关注公众号后，在公众号对话中发送下面的一次性登录码：</p>
      <button id="wechatLoginCode" class="wechat-login-code" type="button" title="点击复制">${escapeHtml(login.loginCode || '')}</button>
      <p class="muted">登录码 5 分钟内有效且仅可使用一次。发送成功后本页面会自动登录。</p>
      <p class="muted">登录状态：<span id="wechatLoginStatus">等待发送登录码</span></p>
    ` : `
      <img class="wechat-qr" src="${escapeHtml(qrCodeUrl)}" alt="微信公众号登录二维码" />
      <p class="muted">请使用微信扫码关注公众号登录。二维码 5 分钟内有效。</p>
      <p class="muted">登录状态：<span id="wechatLoginStatus">等待扫码</span></p>
    `;
    box.querySelector('#wechatLoginCode')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(login.loginCode);
        toast('登录码已复制');
      } catch {
        toast(`请复制登录码：${login.loginCode}`);
      }
    });
    loginPollTimer = setInterval(async () => {
      const status = await api(`/api/wechat/login/status?sessionId=${encodeURIComponent(login.sessionId)}&browserNonce=${encodeURIComponent(browserNonce)}`).catch((error) => ({ status: 'error', error: error.message }));
      const el = document.querySelector('#wechatLoginStatus');
      if (el) el.textContent = loginStatusLabel(status.status, keywordMode);
      if (status.status === 'confirmed') {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
        currentUser = { authenticated: true, type: 'wechat', user: status.user };
        hideLoginOverlay();
        await bootApp();
      }
      if (status.status === 'expired') {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
        if (el) el.textContent = keywordMode ? '登录码已过期，请刷新页面重试' : '二维码已过期，请刷新页面重试';
      }
    }, 1800);
  } catch (error) {
    box.innerHTML = `<div class="error-box">二维码生成失败：${escapeHtml(error.message || String(error))}</div>`;
  }
}

function loginStatusLabel(status, keywordMode = false) {
  return {
    pending: keywordMode ? '等待发送登录码' : '等待扫码',
    confirmed: '登录成功',
    consumed: '登录成功',
    expired: '已过期',
    error: '检查失败'
  }[status] || status;
}

async function loadPlatformCapabilities() {
  try {
    platformCapabilities = await api('/api/platform');
  } catch {
    platformCapabilities = {
      browserAccountSync: { enabled: true, reason: '' },
      cards: { purchaseUrl: '', purchaseHint: '' }
    };
  }
  renderCreditBalance();

  if (syncAccountButton && platformCapabilities.browserAccountSync?.enabled === false) {
    syncAccountButton.disabled = true;
    syncAccountButton.title = platformCapabilities.browserAccountSync.reason || '当前部署环境不支持浏览器缓存同步';
    const label = syncAccountButton.querySelector('.button-label');
    if (label) label.textContent = '账户授权信息已由系统配置';
  }
}

function navigate(path) {
  history.pushState(null, '', path);
  showRoute(path);
  const hash = path.includes('#') ? path.slice(path.indexOf('#')) : '';
  if (hash) {
    requestAnimationFrame(() => document.querySelector(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function routeName(path) {
  if (path.startsWith('/search')) return 'search';
  if (path.startsWith('/jobs') || path.startsWith('/downloads')) return 'jobs';
  return 'home';
}

async function showRoute(path) {
  const page = routeName(path);
  pageViews.forEach((view) => {
    view.hidden = view.dataset.page !== page;
  });
  navLinks.forEach((link) => {
    const activeNav = page === 'jobs' ? 'downloads' : page;
    link.classList.toggle('active', link.dataset.nav === activeNav);
    link.setAttribute('aria-current', link.dataset.nav === activeNav ? 'page' : 'false');
  });

  if (page === 'home') await refreshHome();
  if (page === 'search') await loadSearchPage();
  if (page === 'jobs') await loadJobs();
}

async function refreshHome({ manual = false } = {}) {
  try {
    setButtonBusy(refreshButton, true, '刷新中...');
    await Promise.all([loadDevices(), loadJobs(), loadTopApps()]);
    if (manual) toast('状态已刷新');
  } catch (error) {
    toast(error.message || String(error));
  } finally {
    setButtonBusy(refreshButton, false, '刷新状态');
  }
}

async function syncBrowserAccount() {
  if (platformCapabilities.browserAccountSync?.enabled === false) {
    toast(platformCapabilities.browserAccountSync.reason || '当前部署环境不支持浏览器缓存同步');
    return;
  }
  try {
    setButtonBusy(syncAccountButton, true, '同步中...');
    const result = await api('/api/account/sync-browser', { method: 'POST', body: JSON.stringify({}) });
    const account = result.account || {};
    toast(`账户授权信息已同步：${account.email || '当前账号'} · 凭据 ${account.cookies || 0}`);
  } catch (error) {
    toast(`账户授权信息同步失败：${error.message || String(error)}`);
  } finally {
    setButtonBusy(syncAccountButton, false, '同步账户');
  }
}

async function loadTopApps(force = false) {
  if (cachedTopApps.length && !force) {
    renderTopApps();
    return;
  }
  try {
    setButtonBusy(reloadTopAppsButton, true, '加载中...');
    appGrid.innerHTML = '<div class="empty-state muted">正在读取 App Store 热门应用榜...</div>';
    cachedTopApps = await api('/api/top-apps?country=cn&limit=24');
    renderTopApps();
    if (force) toast('排行榜已刷新');
  } catch (error) {
    appGrid.innerHTML = `<div class="error-box">排行榜加载失败：${escapeHtml(error.message || String(error))}</div>`;
  } finally {
    setButtonBusy(reloadTopAppsButton, false, '刷新排行榜');
  }
}

function renderTopApps() {
  if (!cachedTopApps.length) {
    appGrid.innerHTML = '<div class="empty-state muted">暂无排行榜应用。</div>';
    return;
  }
  appGrid.innerHTML = cachedTopApps.map((app) => `
    <article class="list-row app-row">
      <div class="row-main">
        <img class="app-icon md" src="${escapeHtml(app.artworkUrl || '')}" alt="${escapeHtml(app.name)} 图标" loading="lazy" width="52" height="52">
        <div class="row-copy">
          <div class="row-title-line">
            <h3 class="row-title">${escapeHtml(app.name)}</h3>
            <span class="tiny-pill">#${escapeHtml(app.rank || '')}</span>
          </div>
          <p class="row-subtitle">${escapeHtml(app.artistName || app.sellerName || 'App Store')}</p>
          <div class="row-meta">
            <span>${escapeHtml(app.formattedPrice || priceLabel(app.price))}</span>
            <span>${escapeHtml(app.primaryGenreName || '')}</span>
            <span>v${escapeHtml(app.version || 'N/A')}</span>
          </div>
        </div>
      </div>
      <div class="row-actions">
        <button class="btn btn-primary btn-sm" type="button" data-top-job="${escapeHtml(app.id)}" aria-label="创建 ${escapeHtml(app.name)} 应用解密任务">下载</button>
        <button class="btn btn-ghost btn-sm" type="button" data-top-versions="${escapeHtml(app.id)}">历史版本</button>
      </div>
    </article>
  `).join('');
  appGrid.querySelectorAll('button[data-top-job]').forEach((button) => {
    button.addEventListener('click', () => createSoftwareJob(button.dataset.topJob, button, cachedTopApps));
  });
  appGrid.querySelectorAll('button[data-top-versions]').forEach((button) => {
    button.addEventListener('click', () => openVersionModal(button.dataset.topVersions, button, cachedTopApps));
  });
}

async function loadDevices() {
  if (!currentUser?.authenticated) {
    renderAnonymousDevices();
    updateMetrics();
    return;
  }
  cachedDevices = await api('/api/devices');
  const online = cachedDevices.filter((device) => device.online).length;
  const total = cachedDevices.length;
  deviceSummary.textContent = `${online}/${total} 在线`;
  deviceSummary.className = `pill ${online > 0 ? 'online' : 'neutral'}`;

  if (cachedDevices.length === 0) {
    deviceList.innerHTML = '<div class="empty-state muted">暂无设备配置。请检查 config.local.json。</div>';
    updateMetrics();
    return;
  }

  deviceList.innerHTML = cachedDevices.map((device) => `
    <div class="device-row">
      <div>
        <span class="device-name">${escapeHtml(device.name)}</span>
        <span class="device-url">${escapeHtml(device.baseUrl || '未配置地址')}</span>
      </div>
      <span class="badge ${device.online ? 'completed' : 'failed'}">${device.online ? '在线' : '离线'}</span>
    </div>
  `).join('');
  updateMetrics();
}

async function loadJobs(showToast = false) {
  if (!currentUser?.authenticated) {
    renderAnonymousJobs();
    updateMetrics();
    return;
  }
  try {
    setButtonBusy(refreshJobsButton, true, '刷新中...');
    cachedJobs = await api('/api/jobs');
    renderJobFilters();
    renderJobs();
    updateMetrics();
    if (showToast) toast('任务已刷新');
  } catch (error) {
    if (jobList) jobList.innerHTML = `<div class="error-box">任务加载失败：${escapeHtml(error.message || String(error))}</div>`;
    toast(error.message || String(error));
  } finally {
    setButtonBusy(refreshJobsButton, false, '刷新任务');
  }
}

function renderJobFilters() {
  if (!jobFilters) return;
  const filters = [
    ['all', '全部'],
    ['downloading', '下载中'],
    ['queued', '等待中'],
    ['paused', '已暂停'],
    ['injecting', '注入中'],
    ['decrypting', 'Decrypting'],
    ['completed', '已完成'],
    ['failed', '已失败']
  ];
  jobFilters.innerHTML = filters.map(([value, label]) => {
    const count = value === 'all' ? '' : ` (${countJobsForFilter(value)})`;
    return `<button class="seg-btn" type="button" data-job-filter="${value}" data-active="${jobFilter === value ? 'true' : 'false'}">${label}${count}</button>`;
  }).join('');
  jobFilters.querySelectorAll('[data-job-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      jobFilter = button.dataset.jobFilter || 'all';
      renderJobs();
    });
  });
}

function filteredJobs() {
  if (jobFilter === 'all') return cachedJobs;
  if (jobFilter === 'failed') {
    return cachedJobs.filter((job) => ['failed', 'interrupted', 'needs_verification', 'expired'].includes(job.status));
  }
  if (jobFilter === 'queued') return cachedJobs.filter((job) => job.status === 'queued');
  if (jobFilter === 'injecting') return cachedJobs.filter((job) => job.status === 'running' || job.status === 'uploading');
  return cachedJobs.filter((job) => job.status === jobFilter);
}

function countJobsForFilter(filter) {
  const previous = jobFilter;
  jobFilter = filter;
  const count = filteredJobs().length;
  jobFilter = previous;
  return count;
}

function renderJobs() {
  if (!jobList) return;
  renderJobFilters();
  const jobs = filteredJobs();
  if (cachedJobs.length === 0) {
    jobList.innerHTML = '<div class="empty-state muted">暂无任务。前往应用页选择热门应用或搜索应用开始。</div>';
    return;
  }
  if (jobs.length === 0) {
    jobList.innerHTML = '<div class="empty-state muted">当前筛选下暂无任务。</div>';
    return;
  }

  jobList.innerHTML = jobs.map((job) => `
    <article class="card download-card">
      <div class="download-row">
        <img class="app-icon sm" src="${escapeHtml(job.software?.artworkUrl || job.app.artworkUrl || '')}" alt="${escapeHtml(job.app.name)} 图标" loading="lazy" width="44" height="44">
        <div class="download-body">
          <div class="download-head">
            <div class="min-zero">
              <h3 class="download-title">${escapeHtml(job.app.name)}</h3>
              <p class="download-version">v${escapeHtml(job.software?.version || job.app.version || 'N/A')}</p>
            </div>
            <span class="badge ${escapeHtml(job.status)}">${statusLabel(job.status)}</span>
          </div>
          <p class="download-meta">${escapeHtml(job.software?.bundleID || job.app.bundleId)} · ${formatDate(job.createdAt)}</p>
          <div class="chip-row">
            ${job.unfairdTaskId ? `<span class="pill neutral">任务 ${escapeHtml(shortId(job.unfairdTaskId))}</span>` : ''}
            ${job.forceExtensionDecryption ? '<span class="pill neutral">应用扩展模式</span>' : '<span class="pill neutral">稳定模式</span>'}
            ${renderStoragePill(job)}
          </div>
          ${renderQueueInfo(job)}

          ${isActiveJob(job) ? `
            <div class="progress" aria-label="任务总进度 ${Math.round(clampProgress(job.progress))}%：${escapeHtml(job.progressStageLabel || statusLabel(job.status))}">
              <div style="width:${clampProgress(job.progress)}%"></div>
            </div>
            <div class="progress-meta">
              <span>总进度 ${Math.round(clampProgress(job.progress))}% · ${escapeHtml(job.progressStageLabel || statusLabel(job.status))}</span>
              <span>${escapeHtml(job.speed || '')}</span>
            </div>
          ` : ''}

          ${job.error ? `<p class="alert" data-tone="${['needs_verification', 'expired'].includes(job.status) ? 'warning' : 'error'}">${escapeHtml(errorTitle(job))}：${escapeHtml(job.error)}</p>` : ''}
          ${renderEventSummary(job.decryptEvents || [])}
          ${renderArtifactInfo(job)}
          <div class="download-actions">
            ${job.artifactUrl && job.status !== 'expired' ? `<a class="btn btn-ghost btn-sm btn-success-soft" href="${escapeHtml(job.artifactUrl)}" target="_blank" rel="noreferrer">${escapeHtml(downloadLinkLabel(job))}</a>` : ''}
            <button class="btn btn-danger btn-sm" type="button" disabled>删除</button>
          </div>
          <details class="log-details">
            <summary>查看日志</summary>
            <pre class="log">${escapeHtml((job.logs || []).slice(-12).join('\n') || '等待日志...')}</pre>
          </details>
        </div>
      </div>
    </article>
  `).join('');
}

function submitSearch({ input, country, entity }) {
  const term = input?.value?.trim() || '';
  if (!term) {
    toast('请输入应用名称、App Store ID 或 Bundle ID');
    input?.focus();
    return;
  }

  const params = new URLSearchParams({
    term,
    country: country?.value || 'cn',
    entity: entity?.value || 'software'
  });
  navigate(`/search?${params}`);
}

async function loadSearchPage() {
  const params = new URLSearchParams(location.search);
  const term = params.get('term') || '';
  const country = params.get('country') || 'cn';
  const entity = params.get('entity') || 'software';

  if (searchInput) searchInput.value = term;
  if (searchCountry) searchCountry.value = country;
  if (searchEntity) searchEntity.value = entity;
  if (searchPageInput) searchPageInput.value = term;
  if (searchPageCountry) searchPageCountry.value = country;
  if (searchPageEntity) searchPageEntity.value = entity;

  if (!term.trim()) {
    searchResultSubtitle.textContent = '输入关键词后，这里会展示 App Store 搜索结果。';
    searchResults.innerHTML = '<div class="empty-state muted">暂无搜索关键词。请输入应用名称、App Store ID 或 Bundle ID。</div>';
    return;
  }

  searchResultSubtitle.textContent = `“${term}” 的 App Store 搜索结果`;
  try {
    searchResults.innerHTML = '<div class="empty-state muted">正在搜索 App Store...</div>';
    const request = new URLSearchParams({
      term: term.trim(),
      country,
      entity,
      limit: '25'
    });
    cachedSearchResults = await api(`/api/search?${request}`);
    renderSearchResults();
  } catch (error) {
    searchResults.innerHTML = `<div class="error-box">搜索失败：${escapeHtml(error.message || String(error))}</div>`;
  }
}

function renderSearchResults() {
  if (!cachedSearchResults.length) {
    searchResults.innerHTML = '<div class="empty-state muted">没有搜索到应用。可以换一个关键词或地区再试。</div>';
    return;
  }

  searchResults.innerHTML = cachedSearchResults.map((app) => `
    <article class="list-row search-row" data-search-id="${escapeHtml(app.id)}">
      <div class="row-main">
        <img class="app-icon md" src="${escapeHtml(app.artworkUrl || '')}" alt="${escapeHtml(app.name)} 图标" loading="lazy" width="52" height="52">
        <div class="row-copy">
          <h3 class="row-title">${escapeHtml(app.name)}</h3>
          <p class="row-subtitle">${escapeHtml(app.artistName || app.sellerName || 'Unknown')}</p>
          <div class="row-meta">
            <span>${escapeHtml(app.formattedPrice || priceLabel(app.price))}</span>
            <span>${escapeHtml(app.primaryGenreName || 'App Store')}</span>
            <span>${formatRating(app)}</span>
          </div>
        </div>
      </div>
      <div class="row-actions">
        <button class="btn btn-primary btn-sm" type="button" data-search-job="${escapeHtml(app.id)}">下载</button>
        <button class="btn btn-ghost btn-sm" type="button" data-search-versions="${escapeHtml(app.id)}">历史版本</button>
        <button class="btn btn-ghost btn-sm" type="button" data-toggle-detail="${escapeHtml(app.id)}">详情</button>
      </div>
      <div class="search-more" hidden>
        <div class="detail-grid">
          <div class="detail-item"><span>Bundle ID</span><strong>${escapeHtml(app.bundleID || '')}</strong></div>
          <div class="detail-item"><span>App Store ID</span><strong>${escapeHtml(app.id)}</strong></div>
          <div class="detail-item"><span>版本</span><strong>${escapeHtml(app.version || 'N/A')}</strong></div>
          <div class="detail-item"><span>大小 / 系统</span><strong>${formatSize(app.fileSizeBytes)} · iOS ${escapeHtml(app.minimumOsVersion || 'N/A')}+</strong></div>
          ${app.releaseNotes ? `<div class="detail-item wide"><span>更新说明</span><strong>${escapeHtml(app.releaseNotes)}</strong></div>` : ''}
          ${app.description ? `<div class="detail-item wide"><span>描述</span><strong>${escapeHtml(app.description)}</strong></div>` : ''}
        </div>
        ${renderScreenshots(app.screenshotUrls || [])}
      </div>
    </article>
  `).join('');

  searchResults.querySelectorAll('button[data-search-job]').forEach((button) => {
    button.addEventListener('click', () => createSoftwareJob(button.dataset.searchJob, button, cachedSearchResults));
  });
  searchResults.querySelectorAll('button[data-search-versions]').forEach((button) => {
    button.addEventListener('click', () => openVersionModal(button.dataset.searchVersions, button, cachedSearchResults));
  });
  searchResults.querySelectorAll('button[data-toggle-detail]').forEach((button) => {
    button.addEventListener('click', () => toggleSearchDetail(button.dataset.toggleDetail, button));
  });
}

async function createSoftwareJob(appId, button, source, options = {}) {
  const software = source.find((item) => String(item.id) === String(appId));
  if (!software) {
    toast('未找到应用数据，请重新加载');
    return;
  }
  const resetLabel = options.resetLabel || '下载';
  if (!(await ensureAuthenticated())) return;
  await maybeRefreshNotificationAuthorization();
  try {
    const storefront = selectedStorefrontForSoftware(software, options);
    setButtonBusy(button, true, '发送中...');
    await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        software,
        country: storefront,
        storefront,
        externalVersionId: options.externalVersionId || undefined,
        forceExtensionDecryption: Boolean(forceExtensionToggle.checked)
      })
    });
    const versionText = options.externalVersionId ? `（历史版本 ${options.externalVersionId}）` : '';
    toast(`${software.name || '应用'}${versionText} 任务已发送到 iPhone 队列`);
    await refreshCurrentUser();
    closeVersionModal();
    await loadJobs();
    navigate('/downloads');
  } catch (error) {
    toast(error.message || String(error));
    if (/次数不足|兑换卡密|兑换码/.test(String(error.message || error))) openCreditModal({ focus: true });
  } finally {
    setButtonBusy(button, false, resetLabel);
  }
}

async function maybeRefreshNotificationAuthorization() {
  if (currentUser?.type !== 'wechat') return;
  const status = await api('/api/wechat/notification/status').catch(() => null);
  if (!status?.needsRefresh) return;
  await showNotificationRefreshPrompt(status);
}

function showNotificationRefreshPrompt(status) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'login-overlay';
    overlay.innerHTML = `
      <div class="login-card" role="dialog" aria-modal="true" aria-labelledby="notificationRefreshTitle">
        <button class="icon-button login-close" type="button" data-notification-skip aria-label="关闭通知提醒">×</button>
        <p class="eyebrow">Notification Access</p>
        <h1 id="notificationRefreshTitle">刷新任务通知</h1>
        <p class="login-copy">${status.reason === 'message_limit' ? '本轮 5 条公众号通知额度已用完。' : '公众号通知窗口已超过 48 小时。'}这不会影响当前登录，也不会阻止应用解密。</p>
        <div class="warning-box">扫码并向公众号发送一次性数字后，本次应用解密任务结束时可收到完成或失败通知。</div>
        <div id="notificationRefreshBox" class="wechat-qr-box"></div>
        <div class="download-actions">
          <button class="btn btn-ghost" type="button" data-notification-skip>暂不刷新，继续应用解密</button>
          <button class="btn btn-primary" type="button" data-notification-start>扫码刷新通知</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    let pollTimer = null;
    const finish = () => {
      if (pollTimer) clearInterval(pollTimer);
      overlay.remove();
      resolve();
    };
    overlay.querySelectorAll('[data-notification-skip]').forEach((button) => button.addEventListener('click', finish));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish();
    });
    overlay.querySelector('[data-notification-start]')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      const box = overlay.querySelector('#notificationRefreshBox');
      box.innerHTML = '<div class="empty-state muted">正在生成通知授权二维码...</div>';
      try {
        const browserNonce = crypto.randomUUID();
        const session = await api('/api/wechat/notification/refresh', {
          method: 'POST',
          body: JSON.stringify({ browserNonce })
        });
        const qrCodeUrl = session.qrCodeUrl || session.qrcodeUrl || '';
        box.innerHTML = `
          ${qrCodeUrl ? `<img class="wechat-qr" src="${escapeHtml(qrCodeUrl)}" alt="公众号通知授权二维码" />` : ''}
          <p class="muted">扫码后，在公众号对话中发送下面的 6 位数字：</p>
          <button class="wechat-login-code" type="button" data-copy-notification-code title="点击复制">${escapeHtml(session.loginCode || '')}</button>
          <p class="muted">这是通知授权码，不会退出或重新登录。5 分钟内有效。</p>
          <p class="muted">状态：<span data-notification-status>等待发送数字</span></p>
        `;
        box.querySelector('[data-copy-notification-code]')?.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(session.loginCode || '');
            toast('通知授权码已复制');
          } catch {
            toast(`请复制通知授权码：${session.loginCode || ''}`);
          }
        });
        pollTimer = setInterval(async () => {
          const result = await api(`/api/wechat/notification/refresh-status?sessionId=${encodeURIComponent(session.sessionId)}&browserNonce=${encodeURIComponent(browserNonce)}`).catch((error) => ({ status: 'error', error: error.message }));
          const label = box.querySelector('[data-notification-status]');
          if (label) label.textContent = result.status === 'confirmed' ? '通知已刷新' : result.status === 'expired' ? '授权码已过期' : result.status === 'error' ? `检查失败：${result.error || ''}` : '等待发送数字';
          if (result.status === 'confirmed') {
            toast('公众号通知已刷新，本次任务结束后将推送结果');
            finish();
          } else if (result.status === 'expired') {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }, 1800);
      } catch (error) {
        box.innerHTML = `<div class="error-box">通知授权生成失败：${escapeHtml(error.message || String(error))}</div>`;
        event.currentTarget.disabled = false;
      }
    });
  });
}

async function openVersionModal(appId, button, source) {
  if (!(await ensureAuthenticated())) return;
  const software = source.find((item) => String(item.id) === String(appId));
  if (!software) {
    toast('未找到应用数据，请重新加载');
    return;
  }
  await loadVersionCatalog({
    appId: String(appId),
    software,
    source,
    provider: 'auto',
    button,
    buttonLabel: '历史版本'
  });
}

async function loadVersionCatalog({ appId, software, source, provider = 'auto', button = null, buttonLabel = '历史版本' }) {
  try {
    const storefront = selectedStorefrontForSoftware(software);
    setButtonBusy(button, true, '加载中...');
    const result = await api('/api/apple/default/versions', {
      method: 'POST',
      body: JSON.stringify({ software, country: storefront, storefront, provider })
    });
    const records = Array.isArray(result.records) ? result.records : [];
    seedVersionRecords(String(appId), records);
    const versions = records.length
      ? records.map((record) => String(record.versionId)).filter(Boolean)
      : (Array.isArray(result.versions) ? result.versions : []).map((versionId) => String(versionId)).filter(Boolean);
    versionModalState = {
      appId: String(appId),
      software,
      source,
      storefront,
      versions,
      provider: result.provider || provider,
      requestedProvider: provider,
      providerErrors: Array.isArray(result.errors) ? result.errors : [],
      versionOrder: Object.fromEntries(versions.map((versionId, index) => [String(versionId), index])),
      loadingMetadata: !records.length && versions.length > 0,
      metadataLoadedCount: 0,
      metadataTargetCount: Math.min(versions.length, VERSION_METADATA_PRELOAD_LIMIT),
      metadataSkippedCount: Math.max(0, versions.length - VERSION_METADATA_PRELOAD_LIMIT)
    };
    renderVersionModal();
    if (versionModalState.loadingMetadata) {
      void preloadVersionMetadata(String(appId), software, versionModalState.versions);
    }
  } catch (error) {
    toast(`历史版本加载失败：${error.message || String(error)}`);
  } finally {
    setButtonBusy(button, false, buttonLabel);
  }
}

function renderVersionModal() {
  if (!versionModalState) return;
  let modal = document.querySelector('#versionModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'versionModal';
    modal.className = 'modal-backdrop';
    document.body.appendChild(modal);
  }
  const { software, versions } = versionModalState;
  modal.hidden = false;
  modal.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="versionModalTitle">
      <div class="modal-head">
        <div class="row-main">
          <img class="app-icon lg" src="${escapeHtml(software.artworkUrl || '')}" alt="${escapeHtml(software.name)} 图标" loading="lazy" width="72" height="72">
          <div class="row-copy">
            <h2 id="versionModalTitle" class="modal-title">${escapeHtml(software.name)}</h2>
            <p class="row-subtitle">${escapeHtml(software.bundleID || software.artistName || '')}</p>
            <div class="row-meta">
              <span>当前版本 v${escapeHtml(software.version || 'N/A')}</span>
              <span>${escapeHtml(software.primaryGenreName || 'App Store')}</span>
            </div>
          </div>
        </div>
        <button class="icon-button" type="button" data-close-version aria-label="关闭">×</button>
      </div>
      <div class="version-actions">
        <div class="version-provider-picker" aria-label="历史版本来源">
          <span>来源</span>
          ${VERSION_PROVIDERS.map((provider) => `
            <button class="version-provider-button ${versionProviderSelected(provider) ? 'selected' : ''}" type="button" data-version-provider="${provider}">
              ${escapeHtml(VERSION_PROVIDER_LABELS[provider] || provider)}
            </button>
          `).join('')}
        </div>
        <button class="btn btn-primary btn-sm" type="button" data-version-download="">下载最新版</button>
      </div>
      <div class="version-list">
        ${renderVersionProviderNotice()}
        ${versionModalState.loadingMetadata ? `<div class="alert" data-tone="warning">Apple 源只返回版本 ID，正在快速补齐前 ${Number(versionModalState.metadataTargetCount || 0)} 个版本号；列表可直接下载，不必等待。已完成 ${Number(versionModalState.metadataLoadedCount || 0)} / ${Number(versionModalState.metadataTargetCount || versions.length)} 个。</div>` : ''}
        ${versions.length ? renderVersionGroups(versions) : '<div class="empty-state muted">没有读取到历史版本。可能该应用没有可用旧版，或 Apple 当前没有返回版本列表。</div>'}
      </div>
    </div>
  `;
  modal.onclick = onVersionModalClick;
}

function renderVersionGroups(versionIds) {
  return buildVersionGroups(versionIds).map((group) => {
    if (group.version) return renderVersionGroup(group);
    return renderVersionRow(group.ids[0]);
  }).join('');
}

function versionProviderSelected(provider) {
  const requested = versionModalState?.requestedProvider || 'auto';
  return requested === provider;
}

function renderVersionProviderNotice() {
  if (!versionModalState) return '';
  const provider = versionModalState.provider || versionModalState.requestedProvider || 'auto';
  const label = VERSION_PROVIDER_LABELS[provider] || provider;
  const errors = versionModalState.providerErrors || [];
  if (versionModalState.versions.length) {
    const skipped = Number(versionModalState.metadataSkippedCount || 0);
    const tail = skipped ? `。Apple 详情补齐只预取前 ${VERSION_METADATA_PRELOAD_LIMIT} 个，剩余版本可按需点“刷新详情”` : '';
    return `<div class="version-provider-note">来源：${escapeHtml(label)}，共 ${versionModalState.versions.length} 个历史版本${tail}。</div>`;
  }
  if (errors.length) {
    return `<div class="alert" data-tone="warning">当前来源没有返回历史版本：${escapeHtml(errors.slice(0, 3).join('；'))}</div>`;
  }
  return '';
}

function renderVersionGroup(group) {
  const primaryId = group.ids[0];
  const hasBuilds = group.ids.length > 1;
  const primaryMeta = versionMetaCache.get(versionMetaKey(primaryId));
  const groupSubtitle = hasBuilds
    ? `${group.ids.length} 个构建 · 默认使用最新构建 ${escapeHtml(primaryId)}${primaryMeta?.sizeText ? ` · ${escapeHtml(primaryMeta.sizeText)}` : ''}`
    : versionSubtitle(primaryId, primaryMeta);
  return `
    <div class="version-row version-group" data-version-group="${escapeHtml(group.version)}">
      <div>
        <strong>v${escapeHtml(group.version)}</strong>
        <span>${groupSubtitle}</span>
      </div>
      <div class="row-actions">
        ${hasBuilds ? `<button class="btn btn-ghost btn-sm" type="button" data-toggle-builds="${escapeHtml(group.version)}">${group.expanded ? '收起构建' : '查看构建'}</button>` : ''}
        <button class="btn btn-primary btn-sm" type="button" data-version-download="${escapeHtml(primaryId)}">下载</button>
      </div>
      ${hasBuilds && group.expanded ? `
        <div class="version-builds">
          ${group.ids.map((versionId, index) => `
            <div class="version-build-row">
              <span>构建 ${index + 1} · ${versionSubtitle(versionId, versionMetaCache.get(versionMetaKey(versionId)))}</span>
              <button class="btn btn-ghost btn-sm" type="button" data-version-download="${escapeHtml(versionId)}">下载此构建</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderVersionRow(versionId) {
  const meta = versionMetaCache.get(versionMetaKey(versionId));
  const versionTitle = meta?.displayVersion ? `v${escapeHtml(meta.displayVersion)}` : `ID: ${escapeHtml(versionId)}`;
  return `
    <div class="version-row" data-version-id="${escapeHtml(versionId)}">
      <div>
        <strong>${versionTitle}</strong>
        <span>${meta?.error ? `详情不可用：${escapeHtml(meta.error)}` : versionSubtitle(versionId, meta)}</span>
      </div>
      <div class="row-actions">
        ${meta || versionModalState?.loadingMetadata ? '' : `<button class="btn btn-ghost btn-sm" type="button" data-version-meta="${escapeHtml(versionId)}">刷新详情</button>`}
        <button class="btn btn-primary btn-sm" type="button" data-version-download="${escapeHtml(versionId)}">下载</button>
      </div>
    </div>
  `;
}

function versionSubtitle(versionId, meta) {
  const parts = [`版本 ID：${versionId}`];
  if (meta?.sizeText) parts.push(meta.sizeText);
  if (meta?.source) parts.push(VERSION_PROVIDER_LABELS[meta.source] || meta.source);
  return parts.map((part) => escapeHtml(part)).join(' · ');
}

async function onVersionModalClick(event) {
  const closeButton = event.target.closest('[data-close-version]');
  const downloadButton = event.target.closest('[data-version-download]');
  const providerButton = event.target.closest('[data-version-provider]');
  const metaButton = event.target.closest('[data-version-meta]');
  const buildsButton = event.target.closest('[data-toggle-builds]');
  if (event.target.id === 'versionModal' || closeButton) {
    closeVersionModal();
    return;
  }
  if (buildsButton && versionModalState) {
    const version = buildsButton.dataset.toggleBuilds || '';
    versionModalState.expandedBuildGroups = {
      ...(versionModalState.expandedBuildGroups || {}),
      [version]: !versionModalState.expandedBuildGroups?.[version]
    };
    renderVersionModal();
    return;
  }
  if (providerButton && versionModalState) {
    await reloadVersionProvider(providerButton.dataset.versionProvider, providerButton);
    return;
  }
  if (downloadButton && versionModalState) {
    const versionId = downloadButton.dataset.versionDownload || '';
    await createSoftwareJob(versionModalState.appId, downloadButton, versionModalState.source, {
      externalVersionId: versionId || undefined,
      resetLabel: versionId ? '下载' : '下载最新版'
    });
    return;
  }
  if (metaButton && versionModalState) {
    await loadVersionMetadata(metaButton.dataset.versionMeta, metaButton);
    return;
  }
}

async function reloadVersionProvider(provider, button) {
  if (!versionModalState) return;
  const state = versionModalState;
  await loadVersionCatalog({
    appId: state.appId,
    software: state.software,
    source: state.source,
    provider,
    button,
    buttonLabel: VERSION_PROVIDER_LABELS[provider] || '来源'
  });
}

async function loadVersionMetadata(versionId, button) {
  if (!versionModalState || !versionId) return;
  try {
    setButtonBusy(button, true, '加载中...');
    const result = await api('/api/apple/default/version-info', {
      method: 'POST',
      body: JSON.stringify({
        software: versionModalState.software,
        country: versionModalState.storefront || selectedStorefrontForSoftware(versionModalState.software),
        storefront: versionModalState.storefront || selectedStorefrontForSoftware(versionModalState.software),
        versionId
      })
    });
    if (result.metadata) versionMetaCache.set(versionMetaKey(versionId), normalizeVersionMetadata(result.metadata));
    renderVersionModal();
  } catch (error) {
    toast(`版本详情加载失败：${error.message || String(error)}`);
    setButtonBusy(button, false, '详情');
  }
}

function closeVersionModal() {
  const modal = document.querySelector('#versionModal');
  if (modal) modal.hidden = true;
  versionModalState = null;
}

async function preloadVersionMetadata(appId, software, versionIds) {
  const ids = sortedRawVersionIds(Array.from(new Set(versionIds.map((id) => String(id)).filter(Boolean))));
  const missing = ids
    .filter((versionId) => !versionMetaCache.has(versionMetaKey(versionId, appId)))
    .slice(0, VERSION_METADATA_PRELOAD_LIMIT);
  if (versionModalState?.appId === appId) {
    versionModalState.metadataTargetCount = missing.length;
    versionModalState.metadataSkippedCount = Math.max(0, ids.length - missing.length);
    renderVersionModal();
  }
  if (!missing.length) {
    if (versionModalState?.appId === appId) {
      versionModalState.loadingMetadata = false;
      renderVersionModal();
    }
    return;
  }
  try {
    const result = await api('/api/apple/default/version-info-batch', {
      method: 'POST',
      body: JSON.stringify({
        software,
        country: versionModalState?.storefront || selectedStorefrontForSoftware(software),
        storefront: versionModalState?.storefront || selectedStorefrontForSoftware(software),
        versionIds: missing
      })
    });
    const items = Array.isArray(result.items) ? result.items : [];
    for (const item of items) {
      if (!item?.versionId) continue;
      versionMetaCache.set(versionMetaKey(item.versionId, appId), normalizeVersionMetadata(item.metadata || {}));
    }
  } catch (error) {
    for (const versionId of missing) {
      versionMetaCache.set(versionMetaKey(versionId, appId), {
        displayVersion: '',
        releaseDate: '',
        sizeText: '',
        error: error.message || String(error)
      });
    }
  }
  if (versionModalState?.appId === appId) {
    versionModalState.metadataLoadedCount = missing.length;
    versionModalState.loadingMetadata = false;
    renderVersionModal();
  }
}

function seedVersionRecords(appId, records) {
  for (const record of records || []) {
    const versionId = String(record.versionId || '').trim();
    if (!versionId) continue;
    versionMetaCache.set(versionMetaKey(versionId, appId), normalizeVersionMetadata({
      displayVersion: record.version || record.displayVersion || '',
      releaseDate: record.date || record.releaseDate || '',
      sizeText: record.sizeText || record.size || '',
      source: record.source || ''
    }));
  }
}

function selectedStorefrontForSoftware(software = {}, options = {}) {
  return options.storefront
    || options.country
    || software.storefront
    || software.country
    || searchPageCountry?.value
    || searchCountry?.value
    || 'cn';
}

function buildVersionGroups(versionIds) {
  const groups = new Map();
  const unknown = [];
  for (const versionId of versionIds) {
    const meta = versionMetaCache.get(versionMetaKey(versionId));
    const version = meta?.displayVersion || '';
    if (!version) {
      unknown.push({ version: '', ids: [versionId] });
      continue;
    }
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version).push(versionId);
  }

  const knownGroups = Array.from(groups.entries()).map(([version, ids]) => ({
    version,
    ids: sortedRawVersionIds(ids),
    expanded: Boolean(versionModalState?.expandedBuildGroups?.[version])
  }));

  knownGroups.sort((left, right) => compareVersionStrings(left.version, right.version));
  unknown.sort((left, right) => sortedRawVersionIds([left.ids[0], right.ids[0]]).indexOf(left.ids[0]) === 0 ? -1 : 1);
  return [...knownGroups, ...unknown];
}

function sortedRawVersionIds(versionIds) {
  return [...versionIds].sort((left, right) => String(right).localeCompare(String(left), undefined, { numeric: true }));
}

function compareVersionStrings(left, right) {
  const leftVersion = versionSortParts(left);
  const rightVersion = versionSortParts(right);
  const partCount = Math.max(leftVersion.length, rightVersion.length);
  for (let index = 0; index < partCount; index += 1) {
    const diff = (rightVersion[index] || 0) - (leftVersion[index] || 0);
    if (diff !== 0) return diff;
  }
  return String(right).localeCompare(String(left), undefined, { numeric: true });
}

function versionMetaKey(versionId, appId = versionModalState?.appId || '') {
  return `${appId}:${versionId}`;
}

function normalizeVersionMetadata(meta) {
  return {
    ...meta,
    displayVersion: String(meta.displayVersion || '').replace(/^v/i, ''),
    releaseDate: String(meta.releaseDate || ''),
    sizeText: String(meta.sizeText || ''),
    source: String(meta.source || '')
  };
}

function versionSortParts(value) {
  const text = String(value || '').replace(/^v/i, '');
  const matches = text.match(/\d+/g);
  return matches ? matches.map((part) => Number(part)) : [0];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toggleSearchDetail(appId, button) {
  const card = searchResults.querySelector(`[data-search-id="${CSS.escape(String(appId))}"]`);
  const more = card?.querySelector('.search-more');
  if (!more) return;
  more.hidden = !more.hidden;
  button.textContent = more.hidden ? '详情' : '收起';
}

function renderAnonymousState() {
  cachedDevices = [];
  cachedJobs = [];
  renderAnonymousMetrics();
  renderAnonymousDevices();
  renderAnonymousJobs();
}

function renderAnonymousMetrics() {
  [metricOnline, metricActive, metricOnlineTasks, metricQueued, metricCompleted, metricFailed]
    .filter(Boolean)
    .forEach((element) => {
      element.textContent = '登录后查看';
      element.classList.add('auth-placeholder');
    });
}

function renderAnonymousDevices() {
  if (deviceSummary) {
    deviceSummary.textContent = '登录后查看';
    deviceSummary.className = 'pill neutral';
  }
  if (deviceList) {
    deviceList.innerHTML = `
      <div class="empty-state auth-required-state">
        <strong>登录后查看设备状态</strong>
        <span>设备在线状态和队列信息仅对已登录用户显示。</span>
        <button class="btn btn-primary btn-sm" type="button" data-login-trigger>微信登录</button>
      </div>
    `;
  }
}

function renderAnonymousJobs() {
  if (jobFilters) jobFilters.innerHTML = '';
  if (jobList) {
    jobList.innerHTML = `
      <div class="empty-state auth-required-state">
        <strong>登录后查看任务</strong>
        <span>登录后可查看应用获取、解密、打包和文件上传进度。</span>
        <button class="btn btn-primary btn-sm" type="button" data-login-trigger>微信登录</button>
      </div>
    `;
  }
}

function updateMetrics() {
  if (!metricOnline) return;
  if (!currentUser?.authenticated) {
    renderAnonymousMetrics();
    return;
  }
  [metricOnline, metricActive, metricOnlineTasks, metricQueued, metricCompleted, metricFailed]
    .filter(Boolean)
    .forEach((element) => element.classList.remove('auth-placeholder'));
  const activeStatuses = ['running', 'downloading', 'decrypting', 'uploading'];
  const queued = cachedJobs.filter((job) => job.status === 'queued').length;
  const active = cachedJobs.filter((job) => activeStatuses.includes(job.status)).length;
  metricOnline.textContent = cachedDevices.filter((device) => device.online).length;
  metricActive.textContent = active;
  if (metricOnlineTasks) metricOnlineTasks.textContent = active + queued;
  if (metricQueued) metricQueued.textContent = queued;
  metricCompleted.textContent = cachedJobs.filter((job) => job.status === 'completed').length;
  metricFailed.textContent = cachedJobs.filter((job) => ['failed', 'interrupted', 'needs_verification'].includes(job.status)).length;
}

function renderQueueInfo(job) {
  const queue = job.queue;
  if (!queue) return '';
  if (job.status === 'queued') {
    const position = queue.position ? `第 ${queue.position} 位` : '等待调度';
    const ahead = Number(queue.ahead || 0);
    return `
      <div class="queue-info">
        <span>设备队列：${escapeHtml(position)}</span>
        <span>前方 ${ahead} 个任务</span>
        <span>预计等待 ${escapeHtml(formatDuration(queue.estimatedWaitSeconds))}</span>
      </div>
    `;
  }
  if (['running', 'downloading', 'decrypting', 'uploading'].includes(job.status)) {
    return `
      <div class="queue-info active">
        <span>当前占用设备</span>
        <span>本设备后续排队 ${Number(queue.deviceQueued || 0)} 个</span>
        <span>单任务估算 ${escapeHtml(formatDuration(queue.estimatedJobSeconds))}</span>
      </div>
    `;
  }
  return '';
}

function renderArtifactInfo(job) {
  if (job.status === 'completed' && job.artifactExpiresAt) {
    const target = isCosArtifact(job) ? 'COS 文件和设备内临时 IPA' : '设备内临时 IPA';
    return `<div class="artifact-note">下载链接有效至 ${escapeHtml(formatDate(job.artifactExpiresAt))}，过期后会自动清理${target}。</div>`;
  }
  if (job.status === 'expired') {
    return '<div class="warning-box">下载链接已过期，请重新创建解密任务。</div>';
  }
  return '';
}

function renderStoragePill(job) {
  if (job.status === 'completed' && isCosArtifact(job)) return '<span class="pill online">COS 已上传</span>';
  if (job.status === 'completed' && job.artifactUrl) return '<span class="pill online">本地已保存</span>';
  if (job.status === 'uploading') return '<span class="pill neutral">上传中</span>';
  return '';
}

function downloadLinkLabel(job) {
  return isCosArtifact(job) ? 'COS 下载 IPA' : '下载 IPA';
}

function isCosArtifact(job) {
  const url = String(job.artifactUrl || '');
  return /cos\.|cos\.91ios\.fun|myqcloud\.com|qcloud/i.test(url);
}

function isActiveJob(job) {
  return ['queued', 'running', 'downloading', 'decrypting', 'uploading'].includes(job.status);
}

function renderEventSummary(events) {
  if (!events.length) return '';
  const report = [...events].reverse().find((event) => event.kind === 'report');
  const fullPermission = report
    && Number(report.reportTotal) > 0
    && Number(report.reportDecrypted) === Number(report.reportTotal)
    && Number(report.reportRemaining) === 0
    && Number(report.reportMainRemaining) === 0
    && Number(report.reportFrameworkRemaining) === 0
    && Number(report.reportExtensionRemaining) === 0;
  const counts = events.reduce((acc, event) => {
    const key = event.status || event.kind || 'info';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const labels = {
    decrypted: '已解密',
    success: '成功',
    skipped: '已跳过',
    warning: '警告',
    info: '报告',
    failed: '失败'
  };
  return `
    <div class="job-events" aria-label="解密事件摘要">
      ${report ? `<span class="event-chip ${fullPermission ? 'success' : 'warning'}">${fullPermission ? '完整解密' : '部分解密'}</span>` : ''}
      ${Object.entries(counts).map(([key, count]) => `
        <span class="event-chip ${escapeHtml(key)}">${labels[key] || escapeHtml(key)} ${count}</span>
      `).join('')}
    </div>
  `;
}

function setButtonBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (label) button.textContent = label;
}

function statusLabel(status) {
  return {
    queued: '排队中',
    running: '执行中',
    downloading: '下载中',
    decrypting: '正在解密',
    uploading: '回传中',
    completed: '已完成',
    expired: '已过期',
    needs_verification: '需验证',
    failed: '失败',
    interrupted: '已中断'
  }[status] || status;
}

function errorTitle(job) {
  if (job.status === 'needs_verification') return '需要 Apple ID 验证';
  if (job.status === 'expired' || job.errorCode === 'artifact_expired') return '下载链接已过期';
  if (job.errorCode === 'apple_license_required') return '需要 App Store 许可证';
  return '错误';
}

function shortId(value) {
  return String(value || '').split('-')[0] || '--';
}

function clampProgress(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return value;
  }
}

function formatRating(app) {
  const rating = Number(app.averageUserRating || 0);
  const count = Number(app.userRatingCount || 0);
  return `${rating ? rating.toFixed(1) : 'N/A'} · ${count.toLocaleString('zh-CN')} 次`;
}

function formatSize(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'N/A';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  if (!Number.isFinite(seconds) || seconds === 0) return '即将开始';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function priceLabel(value) {
  return Number(value || 0) === 0 ? '免费' : `¥${value}`;
}

function renderScreenshots(urls) {
  if (!urls.length) return '';
  return `
    <div class="screenshot-strip" aria-label="应用截图">
      ${urls.slice(0, 6).map((url, index) => `
        <img src="${escapeHtml(url)}" alt="应用截图 ${index + 1}" loading="lazy">
      `).join('')}
    </div>
  `;
}

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4200);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function creditBalance() {
  const value = currentUser?.balance ?? currentUser?.user?.balance;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function renderCreditBalance() {
  const isWechatUser = currentUser?.authenticated && currentUser?.type === 'wechat';
  if (creditButton) creditButton.hidden = !isWechatUser;
  if (creditButtonMobile) creditButtonMobile.hidden = !isWechatUser;
  document.querySelectorAll('[data-credit-balance]').forEach((element) => {
    element.textContent = String(creditBalance());
  });
  if (creditPurchaseHint) {
    creditPurchaseHint.textContent = platformCapabilities.cards?.purchaseHint
      || '请在微信公众号回复“购买兑换码”获取购买方式。';
  }
}

function openCreditModal({ focus = false } = {}) {
  if (!currentUser?.authenticated || currentUser?.type !== 'wechat') {
    toast('请先使用微信公众号登录');
    return;
  }
  renderCreditBalance();
  creditModal.hidden = false;
  if (focus) requestAnimationFrame(() => redeemCardInput?.focus());
}

function closeCreditModal() {
  if (creditModal) creditModal.hidden = true;
}

async function redeemCard(event) {
  event.preventDefault();
  const code = String(redeemCardInput?.value || '').trim();
  if (!code) {
    redeemCardInput?.focus();
    return;
  }
  try {
    setButtonBusy(redeemCardButton, true, '兑换中...');
    const result = await api('/api/cards/redeem', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    if (currentUser.user) currentUser.user.balance = result.balance;
    currentUser.balance = result.balance;
    renderCreditBalance();
    redeemCardInput.value = '';
    redeemCardMessage.textContent = `兑换成功，增加 ${Number(result.added || 0)} 次，当前剩余 ${Number(result.balance || 0)} 次。`;
    toast(`兑换成功，当前剩余 ${Number(result.balance || 0)} 次`);
  } catch (error) {
    redeemCardMessage.textContent = `兑换失败：${error.message || String(error)}`;
    toast(`兑换失败：${error.message || String(error)}`);
  } finally {
    setButtonBusy(redeemCardButton, false, '立即兑换');
  }
}

async function refreshCurrentUser() {
  const me = await api('/api/auth/me').catch(() => null);
  if (me?.authenticated) currentUser = me;
  renderCreditBalance();
}

async function bootApp() {
  await loadPlatformCapabilities();
  renderCreditBalance();
  await showRoute(location.pathname + location.search + location.hash);
}

currentUser = await api('/api/auth/me').catch(() => ({ authenticated: false, type: 'anonymous' }));
await bootApp();
setInterval(() => {
  if (currentUser?.authenticated) loadJobs();
}, 4000);
setInterval(() => {
  if (currentUser?.authenticated) loadDevices();
}, 12000);
