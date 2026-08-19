import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeStorefront } from './storefronts.mjs';

const ROLE_ORDER = {
  auditor: 1,
  operator: 2,
  super_admin: 3
};

export class AdminDatabase {
  constructor({ path, legacyConfig = {} }) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.masterKey = deriveMasterKey(process.env.PLATFORM_MASTER_KEY || '');
    this.migrate();
    this.importLegacyConfig(legacyConfig);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'auditor')),
        totp_secret_enc TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT
      );

      CREATE TABLE IF NOT EXISTS device_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        priority_class TEXT NOT NULL DEFAULT 'normal',
        default_weight INTEGER NOT NULL DEFAULT 50,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL UNIQUE,
        access_token_enc TEXT,
        group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
        priority_class TEXT NOT NULL DEFAULT 'normal',
        weight INTEGER NOT NULL DEFAULT 50,
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        enabled INTEGER NOT NULL DEFAULT 1,
        machine_identifier TEXT,
        model_name TEXT,
        ios_version TEXT,
        jailbreak_runtime TEXT,
        provider_name TEXT,
        build_commit TEXT,
        build_timestamp TEXT,
        build_version TEXT,
        build_variant TEXT,
        build_profile TEXT,
        device_architecture TEXT,
        macho_arch TEXT,
        deb_architecture TEXT,
        min_ios TEXT,
        swift_target TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        total_bytes INTEGER,
        free_bytes INTEGER,
        vnode_current INTEGER,
        vnode_limit INTEGER,
        thermal_state TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        last_probe_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS apple_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        email_masked TEXT,
        account_hash TEXT,
        account_data_enc TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_global_default INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS apple_account_devices (
        account_id TEXT NOT NULL REFERENCES apple_accounts(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS apple_account_leases (
        account_id TEXT PRIMARY KEY REFERENCES apple_accounts(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        secret INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT,
        actor_username TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        summary TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        ip_address TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS card_batches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        credit_per_card INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        expires_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        channel TEXT,
        notes TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES card_batches(id) ON DELETE CASCADE,
        code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        credit INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        redeemed_by TEXT,
        redeemed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_credits (
        openid TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        frozen INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credit_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        openid TEXT NOT NULL,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        reference_type TEXT,
        reference_id TEXT,
        actor_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_idempotency
      ON credit_ledger(openid, reason, reference_type, reference_id)
      WHERE reference_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS wechat_users (
        user_key TEXT PRIMARY KEY,
        appid TEXT NOT NULL,
        openid TEXT NOT NULL,
        unionid TEXT,
        subscribed INTEGER NOT NULL DEFAULT 1,
        subscribed_at TEXT,
        unsubscribed_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(appid, openid)
      );

      CREATE TABLE IF NOT EXISTS wechat_event_receipts (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        user_key TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        user_key TEXT,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, channel)
      );
    `);
    this.ensureColumn('devices', 'config_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('devices', 'build_version', 'TEXT');
    this.ensureColumn('devices', 'build_variant', 'TEXT');
    this.ensureColumn('devices', 'build_profile', 'TEXT');
    this.ensureColumn('devices', 'device_architecture', 'TEXT');
    this.ensureColumn('devices', 'macho_arch', 'TEXT');
    this.ensureColumn('devices', 'deb_architecture', 'TEXT');
    this.ensureColumn('devices', 'min_ios', 'TEXT');
    this.ensureColumn('devices', 'swift_target', 'TEXT');
    this.ensureColumn('apple_accounts', 'storefront', "TEXT NOT NULL DEFAULT 'cn'");
    this.seedGroups();
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  seedGroups() {
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO device_groups
        (id, name, priority_class, default_weight, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, '{}', ?, ?)
    `);
    insert.run('primary', '主力设备', 'primary', 80, now, now);
    insert.run('normal', '普通设备', 'normal', 50, now, now);
    insert.run('standby', '备用设备', 'standby', 30, now, now);
    insert.run('test', '测试设备', 'test', 10, now, now);
  }

  importLegacyConfig(config) {
    const alreadyImported = this.getSetting('migration.legacyConfigImported', false);
    if (alreadyImported) {
      for (const [index, device] of (config.devices || []).entries()) {
        if (device.id && !this.device(device.id)) {
          this.upsertDevice({
            ...device,
            groupId: device.groupId || (index === 0 ? 'primary' : 'normal'),
            priorityClass: device.priorityClass || (index === 0 ? 'primary' : 'normal'),
            weight: device.weight ?? (index === 0 ? 80 : 50)
          });
        }
      }
      return;
    }
    for (const [index, device] of (config.devices || []).entries()) {
      this.upsertDevice({
        ...device,
        groupId: device.groupId || (index === 0 ? 'primary' : 'normal'),
        priorityClass: device.priorityClass || (index === 0 ? 'primary' : 'normal'),
        weight: device.weight ?? (index === 0 ? 80 : 50)
      });
    }
    if (config.storage) this.setSetting('storage', config.storage, null);
    if (config.wechat) this.setSetting('notifications.wechat', config.wechat, null, true);
    this.setSetting('migration.legacyConfigImported', true, null);
  }

  bootstrapRequired() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM admins').get().count) === 0;
  }

  createBootstrapAdmin({ username, password }) {
    if (!this.bootstrapRequired()) throw httpError(409, 'administrator already exists');
    validateUsername(username);
    validatePassword(password);
    const id = randomId();
    const secret = randomBase32(20);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO admins
        (id, username, password_hash, role, totp_secret_enc, totp_enabled, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 'super_admin', ?, 0, 1, ?, ?)
    `).run(id, username.trim(), hashPassword(password), this.encrypt(secret), now, now);
    return {
      id,
      username: username.trim(),
      role: 'super_admin',
      secret,
      otpauthUrl: totpAuthURL(username.trim(), secret)
    };
  }

  confirmBootstrap({ username, code, ipAddress, userAgent }) {
    const admin = this.adminByUsername(username);
    if (!admin || admin.totp_enabled) throw httpError(409, 'bootstrap confirmation is unavailable');
    const secret = this.decrypt(admin.totp_secret_enc);
    if (!verifyTotp(secret, code)) throw httpError(401, 'verification code is invalid');
    const now = new Date().toISOString();
    this.db.prepare('UPDATE admins SET totp_enabled = 1, updated_at = ? WHERE id = ?').run(now, admin.id);
    const session = this.createAdminSession(admin.id, ipAddress, userAgent);
    this.audit({
      actorId: admin.id,
      actorUsername: admin.username,
      action: 'admin.bootstrap',
      targetType: 'admin',
      targetId: admin.id,
      summary: '初始化超级管理员',
      ipAddress
    });
    return { admin: publicAdmin({ ...admin, totp_enabled: 1 }), session };
  }

  authenticateAdmin({ username, password, code, ipAddress, userAgent }) {
    const admin = this.adminByUsername(username);
    if (!admin || !admin.enabled) throw httpError(401, '用户名、密码或验证码错误');
    if (admin.locked_until && Date.parse(admin.locked_until) > Date.now()) {
      throw httpError(429, '登录失败次数过多，请稍后再试');
    }
    const passwordOK = verifyPassword(password, admin.password_hash);
    const secret = admin.totp_secret_enc ? this.decrypt(admin.totp_secret_enc) : '';
    const totpOK = admin.totp_enabled ? verifyTotp(secret, code) : false;
    if (!passwordOK || !totpOK) {
      const attempts = Number(admin.failed_attempts || 0) + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      this.db.prepare(`
        UPDATE admins SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?
      `).run(attempts, lockedUntil, new Date().toISOString(), admin.id);
      throw httpError(401, '用户名、密码或验证码错误');
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE admins
      SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, admin.id);
    const session = this.createAdminSession(admin.id, ipAddress, userAgent);
    this.audit({
      actorId: admin.id,
      actorUsername: admin.username,
      action: 'admin.login',
      targetType: 'admin',
      targetId: admin.id,
      summary: '管理员登录',
      ipAddress
    });
    return { admin: publicAdmin(admin), session };
  }

  adminByUsername(username) {
    return this.db.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE')
      .get(String(username || '').trim()) || null;
  }

  createAdminSession(adminId, ipAddress, userAgent) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 12 * 60 * 60_000);
    this.db.prepare(`
      INSERT INTO admin_sessions
        (id, admin_id, token_hash, created_at, expires_at, last_seen_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId(),
      adminId,
      sha256(token),
      now.toISOString(),
      expiresAt.toISOString(),
      now.toISOString(),
      ipAddress || null,
      String(userAgent || '').slice(0, 500)
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  adminForSession(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT a.*, s.id AS session_id, s.expires_at AS session_expires_at
      FROM admin_sessions s
      JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND a.enabled = 1
    `).get(sha256(token), new Date().toISOString());
    if (!row) return null;
    this.db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.session_id);
    return { ...publicAdmin(row), sessionId: row.session_id };
  }

  deleteAdminSession(token, actor = null) {
    if (!token) return;
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
    if (actor) {
      this.audit({
        actorId: actor.id,
        actorUsername: actor.username,
        action: 'admin.logout',
        targetType: 'admin',
        targetId: actor.id,
        summary: '管理员退出'
      });
    }
  }

  requireRole(admin, minimumRole) {
    if (!admin || (ROLE_ORDER[admin.role] || 0) < (ROLE_ORDER[minimumRole] || 0)) {
      throw httpError(403, '权限不足');
    }
  }

  listAdmins(actor) {
    this.requireRole(actor, 'super_admin');
    return this.db.prepare('SELECT * FROM admins ORDER BY created_at').all().map(publicAdmin);
  }

  createAdmin(input, actor) {
    this.requireRole(actor, 'super_admin');
    validateUsername(input.username);
    validatePassword(input.password);
    const role = ['super_admin', 'operator', 'auditor'].includes(input.role) ? input.role : 'auditor';
    const id = randomId();
    const secret = randomBase32(20);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO admins (
        id, username, password_hash, role, totp_secret_enc, totp_enabled,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
    `).run(id, String(input.username).trim(), hashPassword(input.password), role, this.encrypt(secret), now, now);
    this.audit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: 'admin.create',
      targetType: 'admin',
      targetId: id,
      summary: `创建管理员 ${input.username}（${role}）`
    });
    return {
      admin: publicAdmin(this.db.prepare('SELECT * FROM admins WHERE id = ?').get(id)),
      secret,
      otpauthUrl: totpAuthURL(input.username, secret)
    };
  }

  updateAdmin(id, input, actor) {
    this.requireRole(actor, 'super_admin');
    const existing = this.db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
    if (!existing) throw httpError(404, 'administrator not found');
    const role = input.role && ['super_admin', 'operator', 'auditor'].includes(input.role)
      ? input.role
      : existing.role;
    const enabled = input.enabled === undefined ? Boolean(existing.enabled) : Boolean(input.enabled);
    if (id === actor.id && !enabled) throw httpError(409, '不能停用当前登录管理员');
    this.db.prepare('UPDATE admins SET role = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(role, enabled ? 1 : 0, new Date().toISOString(), id);
    this.audit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: 'admin.update',
      targetType: 'admin',
      targetId: id,
      summary: `更新管理员 ${existing.username}`,
      metadata: { role, enabled }
    });
    return publicAdmin(this.db.prepare('SELECT * FROM admins WHERE id = ?').get(id));
  }

  listDevices({ includeSecrets = false } = {}) {
    return this.db.prepare(`
      SELECT d.*, g.name AS group_name
      FROM devices d
      LEFT JOIN device_groups g ON g.id = d.group_id
      ORDER BY
        CASE d.priority_class
          WHEN 'primary' THEN 1 WHEN 'normal' THEN 2 WHEN 'standby' THEN 3 ELSE 4
        END,
        d.weight DESC,
        d.created_at ASC
    `).all().map((row) => deviceFromRow(row, includeSecrets ? this.decrypt(row.access_token_enc) : ''));
  }

  schedulingDevices() {
    return this.listDevices({ includeSecrets: true })
      .filter((device) => device.enabled && !['maintenance', 'quarantined', 'draining'].includes(device.lifecycleState));
  }

  device(id, { includeSecrets = false } = {}) {
    const row = this.db.prepare(`
      SELECT d.*, g.name AS group_name
      FROM devices d
      LEFT JOIN device_groups g ON g.id = d.group_id
      WHERE d.id = ?
    `).get(id);
    return row ? deviceFromRow(row, includeSecrets ? this.decrypt(row.access_token_enc) : '') : null;
  }

  upsertDevice(input, actor = null) {
    const now = new Date().toISOString();
    const existing = input.id ? this.device(input.id, { includeSecrets: true }) : null;
    const id = input.id || slugId(input.name || input.baseUrl || `device-${Date.now()}`);
    const baseUrl = normalizeBaseURL(input.baseUrl);
    const accessToken = input.accessToken === undefined ? (existing?.accessToken || '') : String(input.accessToken || '');
    const groupId = input.groupId || existing?.groupId || 'normal';
    const priorityClass = input.priorityClass || existing?.priorityClass || groupId || 'normal';
    const weight = clampInteger(input.weight ?? existing?.weight ?? 50, 1, 100);
    const lifecycleState = input.lifecycleState || existing?.lifecycleState || 'active';
    const enabled = input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled);
    const deviceConfig = input.config === undefined ? (existing?.config || {}) : input.config;
    this.db.prepare(`
      INSERT INTO devices (
        id, name, base_url, access_token_enc, group_id, priority_class, weight,
        lifecycle_state, enabled, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        access_token_enc = excluded.access_token_enc,
        group_id = excluded.group_id,
        priority_class = excluded.priority_class,
        weight = excluded.weight,
        lifecycle_state = excluded.lifecycle_state,
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      String(input.name || existing?.name || id).trim(),
      baseUrl,
      accessToken ? this.encrypt(accessToken) : null,
      groupId,
      priorityClass,
      weight,
      lifecycleState,
      enabled ? 1 : 0,
      JSON.stringify(deviceConfig && typeof deviceConfig === 'object' ? deviceConfig : {}),
      existing?.createdAt || now,
      now
    );
    if (input.iosVersion !== undefined || input.modelName !== undefined || input.machineIdentifier !== undefined) {
      this.db.prepare(`
        UPDATE devices SET
          ios_version = COALESCE(?, ios_version),
          model_name = COALESCE(?, model_name),
          machine_identifier = COALESCE(?, machine_identifier),
          updated_at = ?
        WHERE id = ?
      `).run(
        nullable(input.iosVersion),
        nullable(input.modelName),
        nullable(input.machineIdentifier),
        now,
        id
      );
    }
    const device = this.device(id);
    if (actor) {
      this.audit({
        actorId: actor.id,
        actorUsername: actor.username,
        action: existing ? 'device.update' : 'device.create',
        targetType: 'device',
        targetId: id,
        summary: `${existing ? '更新' : '添加'}设备 ${device.name}`,
        metadata: { baseUrl, groupId, priorityClass, weight, lifecycleState }
      });
    }
    return device;
  }

  deleteDevice(id, actor = null) {
    const device = this.device(id);
    if (!device) throw httpError(404, 'device not found');
    this.purgeExpiredAccountLeases();
    const lease = this.db.prepare('SELECT job_id FROM apple_account_leases WHERE device_id = ? LIMIT 1').get(id);
    if (lease) throw httpError(409, `设备正被任务 ${lease.job_id} 使用，暂不能删除`);
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    if (actor) {
      this.audit({
        actorId: actor.id,
        actorUsername: actor.username,
        action: 'device.delete',
        targetType: 'device',
        targetId: id,
        summary: `删除设备 ${device.name}`,
        metadata: { baseUrl: device.baseUrl }
      });
    }
    return device;
  }

  updateDeviceProbe(id, probe) {
    const now = new Date().toISOString();
    const online = probe.online !== false;
    const existing = this.device(id);
    if (!existing) return null;
    const failures = online ? 0 : Number(existing.consecutiveFailures || 0) + 1;
    // Quarantine is an automatic circuit-breaker for consecutive probe
    // failures. Once a probe succeeds again, clear only that automatic state
    // so the scheduler can use the recovered device. Explicit maintenance or
    // draining states remain untouched.
    const lifecycleState = online && existing.lifecycleState === 'quarantined'
      ? 'active'
      : failures >= 3 && !['maintenance', 'draining'].includes(existing.lifecycleState)
        ? 'quarantined'
        : existing.lifecycleState;
    this.db.prepare(`
      UPDATE devices SET
        machine_identifier = COALESCE(?, machine_identifier),
        model_name = COALESCE(?, model_name),
        ios_version = COALESCE(?, ios_version),
        jailbreak_runtime = COALESCE(?, jailbreak_runtime),
        provider_name = COALESCE(?, provider_name),
        build_commit = COALESCE(?, build_commit),
        build_timestamp = COALESCE(?, build_timestamp),
        build_version = COALESCE(?, build_version),
        build_variant = COALESCE(?, build_variant),
        build_profile = COALESCE(?, build_profile),
        device_architecture = COALESCE(?, device_architecture),
        macho_arch = COALESCE(?, macho_arch),
        deb_architecture = COALESCE(?, deb_architecture),
        min_ios = COALESCE(?, min_ios),
        swift_target = COALESCE(?, swift_target),
        capabilities_json = ?,
        total_bytes = COALESCE(?, total_bytes),
        free_bytes = COALESCE(?, free_bytes),
        vnode_current = COALESCE(?, vnode_current),
        vnode_limit = COALESCE(?, vnode_limit),
        thermal_state = COALESCE(?, thermal_state),
        consecutive_failures = ?,
        lifecycle_state = ?,
        last_seen_at = ?,
        last_probe_at = ?,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      nullable(probe.machineIdentifier),
      nullable(probe.modelName),
      nullable(probe.iosVersion),
      nullable(probe.jailbreakRuntime),
      nullable(probe.providerName),
      nullable(probe.buildCommit),
      nullable(probe.buildTimestamp),
      nullable(probe.buildVersion),
      nullable(probe.buildVariant),
      nullable(probe.buildProfile),
      nullable(probe.deviceArchitecture),
      nullable(probe.machOArch),
      nullable(probe.debArchitecture),
      nullable(probe.minIOS),
      nullable(probe.swiftTarget),
      JSON.stringify(probe.capabilities || existing.capabilities || {}),
      numberOrNull(probe.totalBytes),
      numberOrNull(probe.freeBytes),
      numberOrNull(probe.vnodeCurrent),
      numberOrNull(probe.vnodeLimit),
      nullable(probe.thermalState),
      failures,
      lifecycleState,
      online ? now : existing.lastSeenAt,
      now,
      online ? null : String(probe.error || 'device offline').slice(0, 1000),
      now,
      id
    );
    return this.device(id);
  }

  listGroups() {
    return this.db.prepare('SELECT * FROM device_groups ORDER BY created_at').all().map((row) => ({
      id: row.id,
      name: row.name,
      priorityClass: row.priority_class,
      defaultWeight: row.default_weight,
      config: parseJson(row.config_json, {})
    }));
  }

  upsertGroup(input, actor = null) {
    const id = String(input.id || '').trim();
    if (!id) throw httpError(400, '设备组 ID 不能为空');
    const existing = this.db.prepare('SELECT * FROM device_groups WHERE id = ?').get(id);
    const now = new Date().toISOString();
    const priorityClass = String(input.priorityClass || existing?.priority_class || id || 'normal');
    const defaultWeight = clampInteger(input.defaultWeight ?? existing?.default_weight ?? 50, 1, 100);
    const groupConfig = input.config === undefined
      ? parseJson(existing?.config_json, {})
      : (input.config && typeof input.config === 'object' ? input.config : {});
    this.db.prepare(`
      INSERT INTO device_groups
        (id, name, priority_class, default_weight, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        priority_class = excluded.priority_class,
        default_weight = excluded.default_weight,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      String(input.name || existing?.name || id).trim(),
      priorityClass,
      defaultWeight,
      JSON.stringify(groupConfig),
      existing?.created_at || now,
      now
    );
    if (actor) {
      this.audit({
        actorId: actor.id,
        actorUsername: actor.username,
        action: existing ? 'device-group.update' : 'device-group.create',
        targetType: 'device-group',
        targetId: id,
        summary: `${existing ? '更新' : '添加'}设备组 ${input.name || existing?.name || id}`,
        metadata: { priorityClass, defaultWeight, config: groupConfig }
      });
    }
    return this.listGroups().find((group) => group.id === id);
  }

  upsertAppleAccount(input, actor = null) {
    const account = input.account && typeof input.account === 'object' ? input.account : null;
    if (!account) throw httpError(400, 'Apple ID 账户态不能为空');
    const now = new Date().toISOString();
    const existing = input.id ? this.appleAccount(input.id, { includeSecret: true }) : null;
    const id = input.id || randomId();
    const email = String(account.email || existing?.account?.email || '').trim();
    const accountHash = String(
      input.accountHash || account.accountHash || account.account_hash || existing?.accountHash || ''
    ).trim();
    const storefront = normalizeStorefront(
      account.storefront
        || account.storeFront
        || account.country
        || account.store
        || input.storefront
        || input.country
        || existing?.storefront
        || 'cn'
    );
    const accountPayload = { ...account, storefront };
    const label = String(input.label || existing?.label || maskEmail(email) || `Apple ID ${id.slice(0, 6)}`).trim();
    const globalDefault = input.isGlobalDefault === undefined
      ? Boolean(existing?.isGlobalDefault)
      : Boolean(input.isGlobalDefault);
    this.withTransaction(() => {
      if (globalDefault) this.db.prepare('UPDATE apple_accounts SET is_global_default = 0').run();
      this.db.prepare(`
        INSERT INTO apple_accounts (
          id, label, email_masked, storefront, account_hash, account_data_enc, priority, enabled,
          is_global_default, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          email_masked = excluded.email_masked,
          storefront = excluded.storefront,
          account_hash = excluded.account_hash,
          account_data_enc = excluded.account_data_enc,
          priority = excluded.priority,
          enabled = excluded.enabled,
          is_global_default = excluded.is_global_default,
          updated_at = excluded.updated_at
      `).run(
        id,
        label,
        maskEmail(email),
        storefront,
        nullable(accountHash),
        this.encrypt(JSON.stringify(accountPayload)),
        clampInteger(input.priority ?? existing?.priority ?? 50, 1, 100),
        input.enabled === false ? 0 : 1,
        globalDefault ? 1 : 0,
        existing?.createdAt || now,
        now
      );
      if (Array.isArray(input.deviceIds)) {
        this.db.prepare('DELETE FROM apple_account_devices WHERE account_id = ?').run(id);
        const assign = this.db.prepare(`
          INSERT OR IGNORE INTO apple_account_devices (account_id, device_id, created_at)
          VALUES (?, ?, ?)
        `);
        for (const deviceId of input.deviceIds) assign.run(id, String(deviceId), now);
      }
    });
    if (actor) {
      this.audit({
        actorId: actor.id,
        actorUsername: actor.username,
        action: existing ? 'apple_account.update' : 'apple_account.create',
        targetType: 'apple_account',
        targetId: id,
        summary: `${existing ? '更新' : '添加'} Apple ID：${label}`
      });
    }
    return this.appleAccount(id);
  }

  listAppleAccounts({ includeSecret = false } = {}) {
    this.purgeExpiredAccountLeases();
    const rows = this.db.prepare(`
      SELECT a.*,
        l.job_id AS lease_job_id,
        l.device_id AS lease_device_id,
        l.expires_at AS lease_expires_at
      FROM apple_accounts a
      LEFT JOIN apple_account_leases l ON l.account_id = a.id
      ORDER BY a.is_global_default DESC, a.priority DESC, a.created_at ASC
    `).all();
    const assignments = this.db.prepare(`
      SELECT account_id, device_id FROM apple_account_devices ORDER BY device_id
    `).all();
    const byAccount = new Map();
    for (const row of assignments) {
      const list = byAccount.get(row.account_id) || [];
      list.push(row.device_id);
      byAccount.set(row.account_id, list);
    }
    return rows.map((row) => appleAccountFromRow(
      row,
      byAccount.get(row.id) || [],
      includeSecret ? parseJson(this.decrypt(row.account_data_enc), null) : null
    ));
  }

  appleAccount(id, { includeSecret = false } = {}) {
    return this.listAppleAccounts({ includeSecret }).find((account) => account.id === id) || null;
  }

  deleteAppleAccount(id, actor = null) {
    const account = this.appleAccount(id);
    if (!account) throw httpError(404, 'Apple ID not found');
    if (account.lease) throw httpError(409, `Apple ID 正被任务 ${account.lease.jobId} 使用，暂不能删除`);
    this.db.prepare('DELETE FROM apple_accounts WHERE id = ?').run(id);
    if (actor) {
      this.audit({
        actorId: actor.id,
        actorUsername: actor.username,
        action: 'apple_account.delete',
        targetType: 'apple_account',
        targetId: id,
        summary: `删除 Apple ID：${account.label}`
      });
    }
    return account;
  }

  acquireAppleAccount({ deviceId, jobId, preferredId = null, excludeIds = [], leaseMinutes = 180, storefront = null }) {
    this.purgeExpiredAccountLeases();
    const excluded = new Set(excludeIds || []);
    const requestedStorefront = storefront ? normalizeStorefront(storefront, '') : '';
    const accounts = this.listAppleAccounts({ includeSecret: true })
      .filter((account) =>
        account.enabled
        && !account.lease
        && !excluded.has(account.id)
        && (!requestedStorefront || account.storefront === requestedStorefront)
      );
    accounts.sort((a, b) => {
      if (preferredId) {
        if (a.id === preferredId && b.id !== preferredId) return -1;
        if (b.id === preferredId && a.id !== preferredId) return 1;
      }
      const aAssigned = a.deviceIds.includes(deviceId) ? 1 : 0;
      const bAssigned = b.deviceIds.includes(deviceId) ? 1 : 0;
      if (aAssigned !== bAssigned) return bAssigned - aAssigned;
      if (a.isGlobalDefault !== b.isGlobalDefault) return Number(b.isGlobalDefault) - Number(a.isGlobalDefault);
      return b.priority - a.priority;
    });
    const selected = accounts.find((account) =>
      !account.deviceIds.length || account.deviceIds.includes(deviceId) || account.isGlobalDefault
    );
    if (!selected) return null;
    const now = new Date();
    this.db.prepare(`
      INSERT INTO apple_account_leases (account_id, job_id, device_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      selected.id,
      jobId,
      deviceId,
      now.toISOString(),
      new Date(now.getTime() + Math.max(10, Number(leaseMinutes)) * 60_000).toISOString()
    );
    this.db.prepare('UPDATE apple_accounts SET last_used_at = ?, updated_at = ? WHERE id = ?')
      .run(now.toISOString(), now.toISOString(), selected.id);
    return { ...selected, lease: { jobId, deviceId } };
  }

  hasEnabledAppleAccount({ storefront = null } = {}) {
    const requestedStorefront = storefront ? normalizeStorefront(storefront, '') : '';
    return this.listAppleAccounts().some((account) =>
      account.enabled && (!requestedStorefront || account.storefront === requestedStorefront)
    );
  }

  releaseAppleAccount(jobId, error = null) {
    const lease = this.db.prepare('SELECT account_id FROM apple_account_leases WHERE job_id = ?').get(jobId);
    if (!lease) return;
    this.db.prepare('DELETE FROM apple_account_leases WHERE job_id = ?').run(jobId);
    if (error) {
      this.db.prepare(`
        UPDATE apple_accounts
        SET failure_count = failure_count + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(String(error).slice(0, 1000), new Date().toISOString(), lease.account_id);
    } else {
      this.db.prepare(`
        UPDATE apple_accounts SET failure_count = 0, last_error = NULL, updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), lease.account_id);
    }
  }

  purgeExpiredAccountLeases() {
    this.db.prepare('DELETE FROM apple_account_leases WHERE expires_at <= ?').run(new Date().toISOString());
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value_json, secret FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    const raw = row.secret ? this.decrypt(row.value_json) : row.value_json;
    return parseJson(raw, fallback);
  }

  setSetting(key, value, actor = null, secret = false) {
    const now = new Date().toISOString();
    const json = JSON.stringify(value);
    this.db.prepare(`
      INSERT INTO settings (key, value_json, secret, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        secret = excluded.secret,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(key, secret ? this.encrypt(json) : json, secret ? 1 : 0, now, actor?.id || null);
    if (actor) {
      this.audit({
        actorId: actor.id,
        actorUsername: actor.username,
        action: 'settings.update',
        targetType: 'settings',
        targetId: key,
        summary: `更新设置 ${key}`
      });
    }
  }

  createCardBatch(input, actor) {
    this.requireRole(actor, 'operator');
    const quantity = clampInteger(input.quantity, 1, 10_000);
    const credit = clampInteger(input.creditPerCard, 1, 100_000);
    const prefix = String(input.prefix || `DK${credit}`).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'DK';
    const now = new Date().toISOString();
    const batchId = randomId();
    const cards = [];
    this.withTransaction(() => {
      this.db.prepare(`
        INSERT INTO card_batches
          (id, name, prefix, credit_per_card, quantity, expires_at, enabled, channel, notes, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        batchId,
        String(input.name || `${prefix}-${now.slice(0, 10)}`),
        prefix,
        credit,
        quantity,
        nullable(input.expiresAt),
        nullable(input.channel),
        nullable(input.notes),
        actor.id,
        now
      );
      const insert = this.db.prepare(`
        INSERT INTO cards (id, batch_id, code, credit, enabled, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `);
      for (let index = 0; index < quantity; index += 1) {
        const code = `${prefix}-${randomCardPart()}-${randomCardPart()}-${randomCardPart()}-${randomCardPart()}`;
        insert.run(randomId(), batchId, code, credit, now);
        cards.push(code);
      }
    });
    this.audit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: 'cards.batch.create',
      targetType: 'card_batch',
      targetId: batchId,
      summary: `生成卡密批次 ${input.name || prefix}，共 ${quantity} 张`,
      metadata: { quantity, credit }
    });
    return { id: batchId, quantity, creditPerCard: credit, prefix, cards };
  }

  listCardBatches() {
    return this.db.prepare(`
      SELECT b.*,
        SUM(CASE WHEN c.redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed_count,
        SUM(CASE WHEN c.enabled = 1 AND c.redeemed_at IS NULL THEN 1 ELSE 0 END) AS available_count
      FROM card_batches b
      LEFT JOIN cards c ON c.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      creditPerCard: row.credit_per_card,
      quantity: row.quantity,
      redeemedCount: Number(row.redeemed_count || 0),
      availableCount: Number(row.available_count || 0),
      expiresAt: row.expires_at,
      enabled: Boolean(row.enabled),
      channel: row.channel,
      notes: row.notes,
      createdAt: row.created_at
    }));
  }

  listCards(batchId, actor) {
    this.requireRole(actor, 'super_admin');
    this.audit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: 'cards.reveal',
      targetType: 'card_batch',
      targetId: batchId,
      summary: '查看完整卡密'
    });
    return this.db.prepare(`
      SELECT id, code, credit, enabled, redeemed_by, redeemed_at, created_at
      FROM cards WHERE batch_id = ? ORDER BY created_at, id
    `).all(batchId).map((row) => ({
      id: row.id,
      code: row.code,
      credit: row.credit,
      enabled: Boolean(row.enabled),
      redeemedBy: row.redeemed_by,
      redeemedAt: row.redeemed_at,
      createdAt: row.created_at
    }));
  }

  redeemCard(code, openid) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized || !openid) throw httpError(400, '卡密和用户不能为空');
    let result;
    this.withTransaction(() => {
      const card = this.db.prepare(`
        SELECT c.*, b.enabled AS batch_enabled, b.expires_at
        FROM cards c JOIN card_batches b ON b.id = c.batch_id
        WHERE c.code = ?
      `).get(normalized);
      if (!card || !card.enabled || !card.batch_enabled) throw httpError(404, '卡密无效');
      if (card.redeemed_at) throw httpError(409, '卡密已被兑换');
      if (card.expires_at && Date.parse(card.expires_at) <= Date.now()) throw httpError(410, '卡密已过期');
      const now = new Date().toISOString();
      const current = this.db.prepare('SELECT balance, frozen FROM user_credits WHERE openid = ?').get(openid);
      if (current?.frozen) throw httpError(403, '用户额度账户已冻结');
      const balance = Number(current?.balance || 0) + Number(card.credit);
      this.db.prepare(`
        INSERT INTO user_credits (openid, balance, frozen, updated_at)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(openid) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at
      `).run(openid, balance, now);
      this.db.prepare('UPDATE cards SET redeemed_by = ?, redeemed_at = ? WHERE id = ?')
        .run(openid, now, card.id);
      this.db.prepare(`
        INSERT INTO credit_ledger
          (openid, delta, balance_after, reason, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'card_redeem', 'card', ?, ?)
      `).run(openid, card.credit, balance, card.id, now);
      result = { balance, added: Number(card.credit) };
    });
    return result;
  }

  upsertWechatUser({ appid, openid, unionid = '', subscribed = true, occurredAt = null }) {
    if (!appid || !openid) throw httpError(400, 'appid and openid are required');
    const userKey = `${appid}:${openid}`;
    const now = occurredAt || new Date().toISOString();
    this.db.prepare(`
      INSERT INTO wechat_users (
        user_key, appid, openid, unionid, subscribed, subscribed_at,
        unsubscribed_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_key) DO UPDATE SET
        unionid = CASE WHEN excluded.unionid <> '' THEN excluded.unionid ELSE wechat_users.unionid END,
        subscribed = excluded.subscribed,
        subscribed_at = CASE WHEN excluded.subscribed = 1 THEN excluded.subscribed_at ELSE wechat_users.subscribed_at END,
        unsubscribed_at = CASE WHEN excluded.subscribed = 0 THEN excluded.unsubscribed_at ELSE NULL END,
        last_seen_at = excluded.last_seen_at
    `).run(
      userKey,
      appid,
      openid,
      unionid,
      subscribed ? 1 : 0,
      subscribed ? now : null,
      subscribed ? null : now,
      now,
      now
    );
    return this.wechatUser(userKey);
  }

  wechatUser(userKey) {
    const row = this.db.prepare(`
      SELECT u.*, COALESCE(c.balance, 0) AS balance, COALESCE(c.frozen, 0) AS frozen
      FROM wechat_users u
      LEFT JOIN user_credits c ON c.openid = u.user_key
      WHERE u.user_key = ?
    `).get(userKey);
    if (!row) return null;
    return {
      userKey: row.user_key,
      appid: row.appid,
      openid: row.openid,
      unionid: row.unionid,
      subscribed: Boolean(row.subscribed),
      balance: Number(row.balance || 0),
      frozen: Boolean(row.frozen),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    };
  }

  grantWelcomeCredits(userKey, credits = 5, eventId = 'first-follow') {
    const amount = clampInteger(credits, 1, 1000);
    let result;
    this.withTransaction(() => {
      const prior = this.db.prepare(`
        SELECT balance_after FROM credit_ledger
        WHERE openid = ? AND reason = 'welcome_bonus'
        LIMIT 1
      `).get(userKey);
      if (prior) {
        result = { granted: false, balance: Number(prior.balance_after) };
        return;
      }
      const current = this.db.prepare('SELECT balance, frozen FROM user_credits WHERE openid = ?').get(userKey);
      if (current?.frozen) throw httpError(403, '用户额度账户已冻结');
      const balance = Number(current?.balance || 0) + amount;
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO user_credits (openid, balance, frozen, updated_at)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(openid) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at
      `).run(userKey, balance, now);
      this.db.prepare(`
        INSERT INTO credit_ledger (
          openid, delta, balance_after, reason, reference_type, reference_id, created_at
        ) VALUES (?, ?, ?, 'welcome_bonus', 'wechat_event', ?, ?)
      `).run(userKey, amount, balance, eventId, now);
      result = { granted: true, balance, added: amount };
    });
    return result;
  }

  recordWechatEvent(event) {
    if (!event?.eventId) throw httpError(400, 'eventId is required');
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO wechat_event_receipts
        (event_id, event_type, user_key, payload_json, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      String(event.type || 'unknown'),
      event.userKey || null,
      JSON.stringify(event.payload || {}),
      event.occurredAt || new Date().toISOString()
    );
    return result.changes === 1;
  }

  startNotificationDelivery(jobId, userKey, channel = 'wechat') {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notification_deliveries
        (id, job_id, user_key, channel, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(job_id, channel) DO UPDATE SET
        status = 'pending',
        attempts = notification_deliveries.attempts + 1,
        updated_at = excluded.updated_at
    `).run(randomId(), jobId, userKey || null, channel, now, now);
  }

  finishNotificationDelivery(jobId, status, error = '', channel = 'wechat') {
    this.db.prepare(`
      UPDATE notification_deliveries
      SET status = ?, last_error = ?, updated_at = ?
      WHERE job_id = ? AND channel = ?
    `).run(status, error ? String(error).slice(0, 2000) : null, new Date().toISOString(), jobId, channel);
  }

  consumeCredit(openid, jobId) {
    let balance;
    this.withTransaction(() => {
      const user = this.db.prepare('SELECT balance, frozen FROM user_credits WHERE openid = ?').get(openid);
      if (!user || Number(user.balance || 0) < 1) throw httpError(402, '可用砸壳次数不足，请先兑换卡密');
      if (user.frozen) throw httpError(403, '用户额度账户已冻结');
      balance = Number(user.balance) - 1;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE user_credits SET balance = ?, updated_at = ? WHERE openid = ?')
        .run(balance, now, openid);
      this.db.prepare(`
        INSERT INTO credit_ledger (
          openid, delta, balance_after, reason, reference_type, reference_id, created_at
        ) VALUES (?, -1, ?, 'job_create', 'job', ?, ?)
      `).run(openid, balance, jobId, now);
    });
    return balance;
  }

  refundCredit(openid, jobId) {
    const prior = this.db.prepare(`
      SELECT 1 FROM credit_ledger
      WHERE openid = ? AND reason = 'job_refund' AND reference_type = 'job' AND reference_id = ?
    `).get(openid, jobId);
    if (prior) return null;
    let balance;
    this.withTransaction(() => {
      const current = this.db.prepare('SELECT balance FROM user_credits WHERE openid = ?').get(openid);
      balance = Number(current?.balance || 0) + 1;
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO user_credits (openid, balance, frozen, updated_at)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(openid) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at
      `).run(openid, balance, now);
      this.db.prepare(`
        INSERT INTO credit_ledger (
          openid, delta, balance_after, reason, reference_type, reference_id, created_at
        ) VALUES (?, 1, ?, 'job_refund', 'job', ?, ?)
      `).run(openid, balance, jobId, now);
    });
    return balance;
  }

  listUserCredits(actor, limit = 500) {
    this.requireRole(actor, 'operator');
    return this.db.prepare(`
      SELECT openid, balance, frozen, updated_at
      FROM user_credits ORDER BY updated_at DESC LIMIT ?
    `).all(clampInteger(limit, 1, 2000)).map((row) => ({
      openid: row.openid,
      balance: Number(row.balance || 0),
      frozen: Boolean(row.frozen),
      updatedAt: row.updated_at
    }));
  }

  withTransaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  audit({
    actorId = null,
    actorUsername = null,
    action,
    targetType = null,
    targetId = null,
    summary,
    metadata = {},
    ipAddress = null
  }) {
    this.db.prepare(`
      INSERT INTO audit_logs
        (actor_id, actor_username, action, target_type, target_id, summary, metadata_json, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actorId,
      actorUsername,
      action,
      targetType,
      targetId,
      summary,
      JSON.stringify(metadata || {}),
      ipAddress,
      new Date().toISOString()
    );
  }

  listAuditLogs({ limit = 100, offset = 0 } = {}) {
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count);
    const items = this.db.prepare(`
      SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(clampInteger(limit, 1, 1000), Math.max(0, Number(offset) || 0)).map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorUsername: row.actor_username,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      summary: row.summary,
      metadata: parseJson(row.metadata_json, {}),
      ipAddress: row.ip_address,
      createdAt: row.created_at
    }));
    return { items, total };
  }

  encrypt(value) {
    if (!value) return '';
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  decrypt(value) {
    if (!value) return '';
    const [version, ivText, tagText, encryptedText] = String(value).split('.');
    if (version !== 'v1' || !ivText || !tagText || !encryptedText) return '';
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }
}

export function verifyTotp(secret, code, now = Date.now()) {
  const normalized = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  for (let offset = -1; offset <= 1; offset += 1) {
    if (totp(secret, now + offset * 30_000) === normalized) return true;
  }
  return false;
}

export function generateTotp(secret, now = Date.now()) {
  return totp(secret, now);
}

function totp(secret, now) {
  const key = decodeBase32(secret);
  const counter = Math.floor(now / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function totpAuthURL(username, secret) {
  const issuer = '91iOS Dump';
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt.${salt.toString('base64url')}.${key.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  try {
    const [version, saltText, expectedText] = String(encoded || '').split('.');
    if (version !== 'scrypt') return false;
    const expected = Buffer.from(expectedText, 'base64url');
    const actual = scryptSync(String(password || ''), Buffer.from(saltText, 'base64url'), expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validateUsername(username) {
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(String(username || ''))) {
    throw httpError(400, '用户名必须为 3–40 位字母、数字、点、横线或下划线');
  }
}

function validatePassword(password) {
  if (String(password || '').length < 12) {
    throw httpError(400, '管理员密码至少需要 12 位');
  }
}

function publicAdmin(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    totpEnabled: Boolean(row.totp_enabled),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  };
}

function deviceFromRow(row, accessToken = '') {
  const lastProbe = row.last_probe_at ? Date.parse(row.last_probe_at) : 0;
  const online = Boolean(row.last_seen_at)
    && Number(row.consecutive_failures || 0) === 0
    && Date.now() - lastProbe < 60_000;
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    accessToken,
    accessTokenConfigured: Boolean(row.access_token_enc),
    groupId: row.group_id,
    groupName: row.group_name,
    priorityClass: row.priority_class,
    weight: row.weight,
    lifecycleState: row.lifecycle_state,
    enabled: Boolean(row.enabled),
    online,
    machineIdentifier: row.machine_identifier,
    modelName: row.model_name,
    iosVersion: row.ios_version,
    jailbreakRuntime: row.jailbreak_runtime,
    providerName: row.provider_name,
    buildCommit: row.build_commit,
    buildTimestamp: row.build_timestamp,
    buildVersion: row.build_version,
    buildVariant: row.build_variant,
    buildProfile: row.build_profile,
    deviceArchitecture: row.device_architecture,
    machOArch: row.macho_arch,
    debArchitecture: row.deb_architecture,
    minIOS: row.min_ios,
    swiftTarget: row.swift_target,
    capabilities: parseJson(row.capabilities_json, {}),
    totalBytes: numberOrNull(row.total_bytes),
    freeBytes: numberOrNull(row.free_bytes),
    vnodeCurrent: numberOrNull(row.vnode_current),
    vnodeLimit: numberOrNull(row.vnode_limit),
    thermalState: row.thermal_state,
    config: parseJson(row.config_json, {}),
    consecutiveFailures: Number(row.consecutive_failures || 0),
    lastSeenAt: row.last_seen_at,
    lastProbeAt: row.last_probe_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function appleAccountFromRow(row, deviceIds, account) {
  return {
    id: row.id,
    label: row.label,
    emailMasked: row.email_masked,
    storefront: normalizeStorefront(row.storefront || account?.storefront || account?.store || account?.country || 'cn'),
    accountHash: row.account_hash,
    priority: Number(row.priority || 0),
    enabled: Boolean(row.enabled),
    isGlobalDefault: Boolean(row.is_global_default),
    failureCount: Number(row.failure_count || 0),
    lastError: row.last_error,
    lastUsedAt: row.last_used_at,
    deviceIds,
    lease: row.lease_job_id ? {
      jobId: row.lease_job_id,
      deviceId: row.lease_device_id,
      expiresAt: row.lease_expires_at
    } : null,
    account,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function maskEmail(value) {
  const email = String(value || '').trim();
  const separator = email.indexOf('@');
  if (separator < 1) return email ? `${email.slice(0, 2)}***` : '';
  const local = email.slice(0, separator);
  return `${local.slice(0, Math.min(3, local.length))}***${local.slice(-Math.min(2, local.length))}${email.slice(separator)}`;
}

function normalizeBaseURL(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw httpError(400, '设备地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, '设备地址必须使用 HTTP 或 HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function deriveMasterKey(value) {
  if (!value) {
    process.stderr.write('[admin] PLATFORM_MASTER_KEY 未设置，当前使用临时兼容密钥；部署前必须配置。\n');
  }
  return createHash('sha256').update(value || 'asspp-development-only-key').digest();
}

function randomId() {
  return randomBytes(16).toString('hex');
}

function slugId(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || `device-${randomBytes(4).toString('hex')}`;
}

function randomCardPart() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';
  for (let index = 0; index < 4; index += 1) {
    value += alphabet[randomBytes(1)[0] % alphabet.length];
  }
  return value;
}

function randomBase32(bytes) {
  return encodeBase32(randomBytes(bytes));
}

function encodeBase32(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const output = [];
  for (const character of String(value || '').toUpperCase().replace(/=+$/, '')) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function nullable(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
