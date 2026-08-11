import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppleAccountLease } from '../apple-account-lease.mjs';

function fixture() {
  const calls = [];
  let leased = false;
  const account = {
    id: 'apple-global',
    label: 'Global account',
    priority: 80,
    enabled: true,
    isGlobalDefault: true,
    deviceIds: [],
    account: { email: 'owner@example.com', cookies: ['old'] }
  };
  return {
    calls,
    store: {
      acquireAppleAccount(input) {
        calls.push(['acquire', input]);
        if (leased) return null;
        leased = true;
        return { ...account, lease: { jobId: input.jobId, deviceId: input.deviceId } };
      },
      upsertAppleAccount(input) {
        calls.push(['update', input]);
      },
      releaseAppleAccount(jobId, error) {
        calls.push(['release', jobId, error]);
        leased = false;
      }
    }
  };
}

test('history requests use the unified Apple account pool without device.accountFile', async () => {
  const value = fixture();
  const device = { id: 'iphone-11', baseUrl: 'http://192.168.100.122:8080' };
  const result = await withAppleAccountLease({
    store: value.store,
    device,
    purpose: 'history',
    storefront: 'us',
    operation: async (account) => ({
      versions: ['100', '99'],
      account: { ...account, cookies: ['refreshed'] }
    })
  });

  assert.deepEqual(result.versions, ['100', '99']);
  assert.equal(value.calls[0][0], 'acquire');
  assert.equal(value.calls[0][1].deviceId, 'iphone-11');
  assert.equal(value.calls[0][1].storefront, 'us');
  assert.equal(value.calls[1][0], 'update');
  assert.deepEqual(value.calls[1][1].account.cookies, ['refreshed']);
  assert.deepEqual(value.calls[2].slice(0, 2), ['release', value.calls[0][1].jobId]);
});

test('history requests release the unified Apple account lease after failure', async () => {
  const value = fixture();
  const device = { id: 'iphone-11' };

  await assert.rejects(
    withAppleAccountLease({
      store: value.store,
      device,
      purpose: 'history',
      operation: async () => {
        throw new Error('upstream failed');
      }
    }),
    /upstream failed/
  );

  assert.equal(value.calls.at(-1)[0], 'release');
  assert.equal(value.calls.at(-1)[2], 'upstream failed');
});
