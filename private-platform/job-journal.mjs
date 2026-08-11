export class JobJournal {
  constructor(database) {
    if (!database) throw new TypeError('database is required');
    this.db = database;
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        device_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS device_job_leases (
        device_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS device_job_leases_job_idx ON device_job_leases(job_id);
    `);
  }

  get(id) {
    const row = this.db.prepare('SELECT payload_json, revision FROM jobs WHERE id = ?').get(String(id));
    return row ? decodeJob(row) : null;
  }

  list() {
    return this.db.prepare('SELECT payload_json, revision FROM jobs ORDER BY created_at, id').all().map(decodeJob);
  }

  save(job, expectedRevision = undefined) {
    if (!job?.id) throw new TypeError('job.id is required');
    const existing = this.db.prepare('SELECT revision FROM jobs WHERE id = ?').get(job.id);
    if (existing && expectedRevision !== undefined && Number(existing.revision) !== Number(expectedRevision)) {
      throw new Error(`stale job revision: expected ${expectedRevision}, current ${existing.revision}`);
    }
    const now = new Date().toISOString();
    const revision = existing ? Number(existing.revision) + 1 : 1;
    const payload = { ...job };
    delete payload.journalRevision;
    this.db.prepare(`
      INSERT INTO jobs (id, status, device_id, revision, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        device_id = excluded.device_id,
        revision = excluded.revision,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      job.id,
      String(job.status || 'queued'),
      job.deviceId || null,
      revision,
      JSON.stringify(payload),
      job.createdAt || now,
      job.updatedAt || now
    );
    return { ...payload, journalRevision: revision };
  }

  saveSnapshot(jobs) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const job of jobs || []) this.save(job);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  importLegacy(jobs) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const job of jobs || []) {
        if (!job?.id || this.get(job.id)) continue;
        this.save(job);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  acquireDeviceLease(deviceId, jobId, leaseSeconds = 6 * 60 * 60) {
    const now = new Date();
    this.db.prepare('DELETE FROM device_job_leases WHERE expires_at <= ?').run(now.toISOString());
    const existing = this.db.prepare('SELECT job_id FROM device_job_leases WHERE device_id = ?').get(deviceId);
    if (existing) return existing.job_id === jobId;
    try {
      this.db.prepare(`
        INSERT INTO device_job_leases (device_id, job_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(
        deviceId,
        jobId,
        now.toISOString(),
        new Date(now.getTime() + Math.max(60, Number(leaseSeconds)) * 1000).toISOString()
      );
      return true;
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) return false;
      throw error;
    }
  }

  releaseDeviceLease(deviceId, jobId) {
    this.db.prepare('DELETE FROM device_job_leases WHERE device_id = ? AND job_id = ?').run(deviceId, jobId);
  }

  activeDeviceIds() {
    this.db.prepare('DELETE FROM device_job_leases WHERE expires_at <= ?').run(new Date().toISOString());
    return new Set(this.db.prepare('SELECT device_id FROM device_job_leases').all().map((row) => row.device_id));
  }
}

function decodeJob(row) {
  return { ...JSON.parse(row.payload_json), journalRevision: Number(row.revision) };
}
