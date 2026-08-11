import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeNotificationMessage,
  notificationWindowStatus,
  refreshedNotificationWindow
} from '../notification-window.mjs';

test('notification window expires after 48 hours', () => {
  const now = Date.parse('2026-08-02T00:00:00Z');
  const fresh = refreshedNotificationWindow(now);
  assert.equal(notificationWindowStatus(fresh, now + 47 * 60 * 60 * 1000).needsRefresh, false);
  assert.equal(notificationWindowStatus(fresh, now + 48 * 60 * 60 * 1000).reason, 'expired');
});

test('notification window asks for refresh after five sent messages', () => {
  const now = Date.parse('2026-08-02T00:00:00Z');
  let value = refreshedNotificationWindow(now);
  for (let index = 0; index < 5; index += 1) value = consumeNotificationMessage(value, now);
  assert.deepEqual(notificationWindowStatus(value, now), {
    available: false,
    needsRefresh: true,
    reason: 'message_limit',
    openedAt: '2026-08-02T00:00:00.000Z',
    expiresAt: '2026-08-04T00:00:00.000Z',
    sentCount: 5,
    remainingMessages: 0
  });
});
