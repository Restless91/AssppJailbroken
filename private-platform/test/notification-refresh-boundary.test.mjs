import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('notification refresh never replaces the current web login session', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("if (url.pathname === '/api/wechat/notification/refresh-status'");
  const end = source.indexOf("if (url.pathname === '/api/cards/redeem'", start);

  assert.ok(start >= 0, 'notification refresh status route must exist');
  assert.ok(end > start, 'notification refresh route boundary must be detectable');

  const route = source.slice(start, end);
  assert.match(route, /refreshNotificationWindow\(actor\.openid\)/);
  assert.doesNotMatch(route, /createWebSession|setSessionCookie/);
});
