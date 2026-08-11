import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

test('public top-apps route does not require an enabled decryption device', () => {
  const route = serverSource.match(
    /if \(url\.pathname === '\/api\/top-apps'[\s\S]*?\n  }\n  if \(url\.pathname === '\/api\/search'/
  )?.[0] || '';

  assert.ok(route, 'top-apps route was not found');
  assert.doesNotMatch(route, /selectDevice\(/);
  assert.match(route, /loadTopApps\(deviceId, country, limit\)/);
});

test('top-apps enriches public RSS entries through the online device pool when available', () => {
  const loader = serverSource.match(
    /async function loadTopApps\([\s\S]*?\n}\n\nfunction rssEntryToSoftware/
  )?.[0] || '';

  assert.ok(loader, 'loadTopApps function was not found');
  assert.match(loader, /devicePool\.run\(/);
  assert.match(loader, /canLoadDeviceDetails/);
  assert.match(loader, /rssEntryToSoftware\(/);
});
