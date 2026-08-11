import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AdminDatabase, generateTotp, verifyTotp } from '../admin-db.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'asspp-admin-'));
  process.env.PLATFORM_MASTER_KEY = 'test-master-key-that-is-not-used-in-production';
  const store = new AdminDatabase({
    path: join(directory, 'platform.sqlite'),
    legacyConfig: {
      devices: [{
        id: 'iphone-main',
        name: 'Main iPhone',
        baseUrl: 'http://192.168.100.227:8080'
      }]
    }
  });
  return {
    store,
    cleanup() {
      store.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('TOTP verifies the RFC SHA-1 six digit suffix', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(generateTotp(secret, 59_000), '287082');
  assert.equal(verifyTotp(secret, '287082', 59_000), true);
  assert.equal(verifyTotp(secret, '000000', 59_000), false);
});

test('bootstrap, device scheduling, encrypted Apple accounts and leases work', () => {
  const value = fixture();
  try {
    const bootstrap = value.store.createBootstrapAdmin({
      username: 'owner',
      password: 'very-long-test-password'
    });
    const confirmed = value.store.confirmBootstrap({
      username: 'owner',
      code: generateTotp(bootstrap.secret)
    });
    assert.equal(confirmed.admin.role, 'super_admin');
    assert.equal(value.store.schedulingDevices()[0].id, 'iphone-main');
    value.store.upsertGroup({
      id: 'primary',
      config: { maxAttemptsPerDevice: 3, skipExtensions: true }
    }, confirmed.admin);
    value.store.upsertDevice({
      ...value.store.device('iphone-main', { includeSecrets: true }),
      iosVersion: '16.2',
      config: { skipExtensions: false }
    }, confirmed.admin);
    assert.deepEqual(value.store.listGroups().find((group) => group.id === 'primary').config, {
      maxAttemptsPerDevice: 3,
      skipExtensions: true
    });
    assert.deepEqual(value.store.device('iphone-main').config, { skipExtensions: false });
    assert.equal(value.store.device('iphone-main').iosVersion, '16.2');

    const account = value.store.upsertAppleAccount({
      label: 'Default account',
      storefront: 'us',
      account: { email: 'owner@example.com', password: 'secret-cookie-state' },
      isGlobalDefault: true
    }, confirmed.admin);
    assert.equal(account.emailMasked, 'own***er@example.com');
    assert.equal(account.storefront, 'us');
    assert.equal(value.store.listAppleAccounts()[0].account, null);
    assert.equal(value.store.hasEnabledAppleAccount({ storefront: 'us' }), true);
    assert.equal(value.store.hasEnabledAppleAccount({ storefront: 'cn' }), false);
    assert.equal(value.store.acquireAppleAccount({
      deviceId: 'iphone-main',
      jobId: 'job-cn',
      storefront: 'cn'
    }), null);

    const lease = value.store.acquireAppleAccount({
      deviceId: 'iphone-main',
      jobId: 'job-1',
      storefront: 'us'
    });
    assert.equal(lease.id, account.id);
    assert.equal(value.store.acquireAppleAccount({
      deviceId: 'iphone-main',
      jobId: 'job-2'
    }), null);
    value.store.releaseAppleAccount('job-1');
    assert.equal(value.store.acquireAppleAccount({
      deviceId: 'iphone-main',
      jobId: 'job-2',
      storefront: 'us'
    }).id, account.id);
  } finally {
    value.cleanup();
  }
});

test('Apple account native storefront overrides manual fallback storefront', () => {
  const value = fixture();
  try {
    const usAccount = value.store.upsertAppleAccount({
      label: 'Synced US account',
      storefront: 'cn',
      account: {
        email: 'us-owner@example.com',
        storeFront: '143441-1,29',
        password: 'secret-cookie-state'
      }
    });
    assert.equal(usAccount.storefront, 'us');
    assert.equal(value.store.appleAccount(usAccount.id, { includeSecret: true }).account.storefront, 'us');

    const cnAccount = value.store.upsertAppleAccount({
      label: 'Synced CN account',
      storefront: 'us',
      account: {
        email: 'cn-owner@example.com',
        country: '143465-19,29',
        password: 'secret-cookie-state'
      }
    });
    assert.equal(cnAccount.storefront, 'cn');
    assert.equal(value.store.appleAccount(cnAccount.id, { includeSecret: true }).account.storefront, 'cn');
  } finally {
    value.cleanup();
  }
});

test('devices and Apple accounts can only be deleted while not leased', () => {
  const value = fixture();
  try {
    const account = value.store.upsertAppleAccount({
      label: 'Disposable account',
      account: { email: 'delete@example.com', password: 'secret-cookie-state' }
    });
    value.store.acquireAppleAccount({ deviceId: 'iphone-main', jobId: 'job-delete' });
    assert.throws(() => value.store.deleteAppleAccount(account.id), /job-delete/);
    assert.throws(() => value.store.deleteDevice('iphone-main'), /job-delete/);
    value.store.releaseAppleAccount('job-delete');
    assert.equal(value.store.deleteAppleAccount(account.id).id, account.id);
    assert.equal(value.store.appleAccount(account.id), null);
    assert.equal(value.store.deleteDevice('iphone-main').id, 'iphone-main');
    assert.equal(value.store.device('iphone-main'), null);
    assert.throws(() => value.store.deleteDevice('iphone-main'), /device not found/);
  } finally {
    value.cleanup();
  }
});

test('Apple account storefront falls back to manual input when account state has no storefront', () => {
  const value = fixture();
  try {
    const account = value.store.upsertAppleAccount({
      label: 'Manual fallback',
      storefront: 'jp',
      account: {
        email: 'fallback@example.com',
        password: 'secret-cookie-state'
      }
    });
    assert.equal(account.storefront, 'jp');
    assert.equal(value.store.appleAccount(account.id, { includeSecret: true }).account.storefront, 'jp');
  } finally {
    value.cleanup();
  }
});

test('cards credit a user and task debit/refund is idempotent', () => {
  const value = fixture();
  try {
    const bootstrap = value.store.createBootstrapAdmin({
      username: 'owner',
      password: 'very-long-test-password'
    });
    const { admin } = value.store.confirmBootstrap({
      username: 'owner',
      code: generateTotp(bootstrap.secret)
    });
    const batch = value.store.createCardBatch({
      name: 'Five uses',
      quantity: 1,
      creditPerCard: 5
    }, admin);
    assert.equal(value.store.redeemCard(batch.cards[0], 'openid-1').balance, 5);
    assert.equal(value.store.consumeCredit('openid-1', 'job-1'), 4);
    assert.equal(value.store.refundCredit('openid-1', 'job-1'), 5);
    assert.equal(value.store.refundCredit('openid-1', 'job-1'), null);
  } finally {
    value.cleanup();
  }
});

test('wechat identity and first-follow gift are composite and idempotent', () => {
  const value = fixture();
  try {
    const first = value.store.upsertWechatUser({ appid: 'wx-a', openid: 'same-openid' });
    const second = value.store.upsertWechatUser({ appid: 'wx-b', openid: 'same-openid' });
    assert.notEqual(first.userKey, second.userKey);
    assert.deepEqual(value.store.grantWelcomeCredits(first.userKey, 5, 'event-1'), {
      granted: true,
      balance: 5,
      added: 5
    });
    assert.deepEqual(value.store.grantWelcomeCredits(first.userKey, 5, 'event-2'), {
      granted: false,
      balance: 5
    });
    assert.equal(value.store.recordWechatEvent({
      eventId: 'event-1',
      type: 'wechat.subscribe',
      userKey: first.userKey
    }), true);
    assert.equal(value.store.recordWechatEvent({
      eventId: 'event-1',
      type: 'wechat.subscribe',
      userKey: first.userKey
    }), false);
  } finally {
    value.cleanup();
  }
});
