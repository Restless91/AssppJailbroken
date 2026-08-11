const stages = {
  queued: { start: 0, end: 0, label: '排队等待' },
  preparing: { start: 2, end: 12, label: '准备下载材料' },
  router_download: { start: 12, end: 42, label: 'App Store 下载' },
  device_transfer: { start: 42, end: 55, label: '传输到 iPhone' },
  device_prepare: { start: 55, end: 58, label: '安装与启动' },
  decrypting: { start: 58, end: 84, label: '应用解密' },
  packaging: { start: 84, end: 90, label: '打包 IPA' },
  retrieving: { start: 90, end: 94, label: '回传到 iStoreOS' },
  uploading: { start: 94, end: 99, label: '上传到 COS' },
  completed: { start: 100, end: 100, label: '全部完成' }
};

export function calculateWorkflowProgress(stage, stageProgress = 0) {
  const definition = stages[stage] || stages.preparing;
  const local = clamp(stageProgress);
  return round(definition.start + ((definition.end - definition.start) * local / 100));
}

export function updateWorkflowProgress(job, stage, stageProgress = 0, { reset = false } = {}) {
  const calculated = calculateWorkflowProgress(stage, stageProgress);
  job.workflowStage = stage;
  job.stageProgress = clamp(stageProgress);
  job.progress = reset ? calculated : Math.max(Number(job.progress || 0), calculated);
  return workflowProgressView(job);
}

export function updateFromDeviceTask(job, task) {
  const status = String(task?.status || '');
  job.deviceQueuePosition = Number.isFinite(Number(task?.queuePosition))
    ? Number(task.queuePosition)
    : null;
  job.deviceCanRetry = task?.canRetry === true;
  if (status === 'pending') {
    return updateWorkflowProgress(job, 'device_transfer', task?.progress || 0);
  }
  if (status === 'downloading') {
    return updateWorkflowProgress(job, 'device_transfer', task?.progress || 0);
  }
  if (status === 'injecting') {
    return updateWorkflowProgress(job, 'device_prepare', 45);
  }
  if (status === 'decrypting') {
    const logs = Array.isArray(task?.logs) ? task.logs : [];
    const isPackaging = logs.some((line) => /\b(packag|archive|output:|zip)\b/i.test(String(line)));
    if (isPackaging) return updateWorkflowProgress(job, 'packaging', 35);
    const eventCount = Array.isArray(task?.decryptEvents) ? task.decryptEvents.length : 0;
    return updateWorkflowProgress(job, 'decrypting', Math.min(90, 12 + eventCount * 5));
  }
  if (status === 'completed') {
    return updateWorkflowProgress(job, 'packaging', 100);
  }
  return updateWorkflowProgress(job, 'device_prepare', 0);
}

export function workflowProgressView(job) {
  const stage = job?.workflowStage || inferLegacyStage(job);
  const definition = stages[stage] || stages.preparing;
  const progress = job?.workflowStage
    ? clamp(job.progress)
    : calculateWorkflowProgress(stage, inferredStageProgress(job, stage));
  return {
    progress,
    workflowStage: stage,
    progressStageLabel: definition.label,
    stageProgress: clamp(job?.stageProgress || 0)
  };
}

function inferLegacyStage(job) {
  if (job?.status === 'completed') return 'completed';
  if (job?.status === 'uploading') return 'uploading';
  if (job?.status === 'decrypting') return 'decrypting';
  if (job?.status === 'downloading') return job?.unfairdTaskId ? 'device_transfer' : 'router_download';
  if (job?.status === 'queued') return 'queued';
  return 'preparing';
}

function inferredStageProgress(job, stage) {
  if (stage === 'completed') return 100;
  if (stage === 'device_transfer' || stage === 'router_download') return job?.progress || 0;
  if (stage === 'decrypting') return 20;
  return 0;
}

function clamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function round(value) {
  return Math.round(value * 10) / 10;
}
