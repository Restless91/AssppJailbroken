import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateWorkflowProgress,
  updateFromDeviceTask,
  updateWorkflowProgress,
  workflowProgressView
} from '../workflow-progress.mjs';

test('workflow stages occupy stable non-overlapping ranges', () => {
  assert.equal(calculateWorkflowProgress('router_download', 0), 12);
  assert.equal(calculateWorkflowProgress('router_download', 50), 27);
  assert.equal(calculateWorkflowProgress('router_download', 100), 42);
  assert.equal(calculateWorkflowProgress('device_transfer', 100), 55);
  assert.equal(calculateWorkflowProgress('completed', 0), 100);
});

test('workflow progress never moves backwards inside one attempt', () => {
  const job = { progress: 0 };
  updateWorkflowProgress(job, 'router_download', 80);
  assert.equal(job.progress, 36);
  updateWorkflowProgress(job, 'router_download', 20);
  assert.equal(job.progress, 36);
  updateWorkflowProgress(job, 'device_transfer', 10);
  assert.equal(job.progress, 43.3);
});

test('device task progress is mapped into the full lifecycle', () => {
  const job = { progress: 42 };
  updateFromDeviceTask(job, { status: 'downloading', progress: 50 });
  assert.equal(job.progress, 48.5);
  updateFromDeviceTask(job, {
    status: 'decrypting',
    progress: 100,
    decryptEvents: [{ status: 'decrypted' }, { status: 'decrypted' }]
  });
  assert.equal(job.workflowStage, 'decrypting');
  assert.ok(job.progress >= 58 && job.progress < 84);
  updateFromDeviceTask(job, { status: 'completed', progress: 100 });
  assert.equal(job.progress, 90);
});

test('device pending state preserves the assigned workflow and queue metadata', () => {
  const job = { progress: 42 };
  updateFromDeviceTask(job, { status: 'pending', progress: 0, queuePosition: 2, canRetry: true });
  assert.equal(job.workflowStage, 'device_transfer');
  assert.equal(job.progress, 42);
  assert.equal(job.deviceQueuePosition, 2);
  assert.equal(job.deviceCanRetry, true);
});

test('legacy jobs receive a useful workflow view', () => {
  assert.deepEqual(
    workflowProgressView({ status: 'completed', progress: 100 }).progressStageLabel,
    '全部完成'
  );
  assert.equal(
    workflowProgressView({ status: 'downloading', progress: 50, unfairdTaskId: 'task' }).progress,
    48.5
  );
});
