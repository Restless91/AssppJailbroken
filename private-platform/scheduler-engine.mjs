const activeStatuses = new Set(['running', 'downloading', 'decrypting', 'uploading']);

export function admitJob(jobs, openid, config = {}) {
  if (!openid) return { admitted: true, code: 'admin_bypass' };
  const maxQueued = Math.max(1, Number(config.maxQueuedPerUser || 3));
  const maxGlobal = Math.max(1, Number(config.maxQueuedGlobal || 100));
  const queued = (jobs || []).filter((job) => job.status === 'queued');
  if (queued.length >= maxGlobal) return { admitted: false, code: 'global_queue_limit' };
  if (queued.filter((job) => job.openid === openid).length >= maxQueued) {
    return { admitted: false, code: 'user_queue_limit' };
  }
  return { admitted: true, code: 'admitted' };
}

export function fairQueueOrder(jobs) {
  const ordered = [...(jobs || [])].sort((a, b) =>
    Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)
  );
  const groups = new Map();
  for (const job of ordered) {
    const key = job.openid || `admin:${job.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const result = [];
  while (groups.size) {
    for (const [key, queue] of groups) {
      result.push(queue.shift());
      if (!queue.length) groups.delete(key);
    }
  }
  return result;
}

export function canDispatchJob(job, jobs, config = {}) {
  if (!job?.openid) return true;
  const maxActive = Math.max(1, Number(config.maxActivePerUser || 1));
  const activeForUser = (jobs || []).filter((item) =>
    item.openid === job.openid && activeStatuses.has(item.status)
  ).length;
  return activeForUser < maxActive;
}
