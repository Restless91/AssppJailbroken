export const NOTIFICATION_WINDOW_MS = 48 * 60 * 60 * 1000;
export const NOTIFICATION_MESSAGE_LIMIT = 5;

export function notificationWindowStatus(value = null, now = Date.now()) {
  const openedAt = value?.openedAt || null;
  const sentCount = Math.max(0, Number(value?.sentCount || 0));
  const expiresAtMs = openedAt ? Date.parse(openedAt) + NOTIFICATION_WINDOW_MS : 0;
  const expired = !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
  const exhausted = sentCount >= NOTIFICATION_MESSAGE_LIMIT;
  return {
    available: !expired && !exhausted,
    needsRefresh: expired || exhausted,
    reason: exhausted ? 'message_limit' : expired ? 'expired' : null,
    openedAt,
    expiresAt: expired || !openedAt ? null : new Date(expiresAtMs).toISOString(),
    sentCount,
    remainingMessages: Math.max(0, NOTIFICATION_MESSAGE_LIMIT - sentCount)
  };
}

export function refreshedNotificationWindow(now = Date.now()) {
  return { openedAt: new Date(now).toISOString(), sentCount: 0 };
}

export function consumeNotificationMessage(value = null, now = Date.now()) {
  const current = value?.openedAt ? value : refreshedNotificationWindow(now);
  return { ...current, sentCount: Math.max(0, Number(current.sentCount || 0)) + 1 };
}
