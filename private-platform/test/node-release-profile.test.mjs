import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeNodeInfo } from '../admin-system.mjs';

test('normalizes the daemon release profile from NodeInfo build metadata', () => {
  const info = normalizeNodeInfo({
    build: {
      commit: 'abc123',
      timestamp: '2026-08-13T00:00:00Z',
      version: '0.1.16',
      variant: 'iphone15',
      profile: 'rootless',
      deviceArchitecture: 'arm64e',
      machOArch: 'arm64',
      debArchitecture: 'iphoneos-arm64',
      minIOS: '15.0',
      swiftTarget: 'arm64-apple-ios15.0'
    }
  });

  assert.deepEqual({
    buildVersion: info.buildVersion,
    buildVariant: info.buildVariant,
    buildProfile: info.buildProfile,
    deviceArchitecture: info.deviceArchitecture,
    machOArch: info.machOArch,
    debArchitecture: info.debArchitecture,
    minIOS: info.minIOS,
    swiftTarget: info.swiftTarget
  }, {
    buildVersion: '0.1.16',
    buildVariant: 'iphone15',
    buildProfile: 'rootless',
    deviceArchitecture: 'arm64e',
    machOArch: 'arm64',
    debArchitecture: 'iphoneos-arm64',
    minIOS: '15.0',
    swiftTarget: 'arm64-apple-ios15.0'
  });
});

test('keeps legacy node responses without release metadata compatible', () => {
  const info = normalizeNodeInfo({ status: 'ok', build_commit: 'legacy' });
  assert.equal(info.buildCommit, 'legacy');
  assert.equal(info.buildVersion, null);
  assert.equal(info.buildVariant, null);
  assert.equal(info.buildProfile, null);
  assert.equal(info.deviceArchitecture, null);
  assert.equal(info.machOArch, null);
  assert.equal(info.debArchitecture, null);
  assert.equal(info.minIOS, null);
  assert.equal(info.swiftTarget, null);
});

test('admin device cards show release, profile and architecture metadata', async () => {
  const script = await readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
  assert.match(script, /daemon 版本/);
  assert.match(script, /构建 Profile/);
  assert.match(script, /设备 \/ Mach-O \/ Deb/);
  assert.match(script, /最低 iOS \/ Swift Target/);
});
