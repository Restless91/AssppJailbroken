import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicDir = new URL('../public/', import.meta.url);

test('public login only exposes the WeChat flow', async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL('app.js', publicDir), 'utf8'),
    readFile(new URL('styles.css', publicDir), 'utf8')
  ]);

  for (const legacyAdminLogin of [
    'platformAdminToken',
    'adminLoginForm',
    'X-Admin-Token',
    '管理员 Token',
    '管理员登录'
  ]) {
    assert.equal(app.includes(legacyAdminLogin), false, `legacy public admin login remains: ${legacyAdminLogin}`);
  }
  assert.equal(styles.includes('.admin-login-form'), false);
  assert.match(app, /使用微信公众号登录/);
});

test('anonymous users receive explicit protected-area placeholders', async () => {
  const app = await readFile(new URL('app.js', publicDir), 'utf8');

  assert.match(app, /登录后查看设备状态/);
  assert.match(app, /登录后查看任务/);
  assert.match(app, /data-login-trigger/);
  assert.match(app, /async function openVersionModal[\s\S]*ensureAuthenticated/);
  assert.match(app, /async function createSoftwareJob[\s\S]*ensureAuthenticated/);
});
