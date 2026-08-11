import assert from 'node:assert/strict';
import test from 'node:test';
import { cosSignedDownloadUrl } from '../cos-signing.mjs';

const config = {
  secretId: 'AKIDEXAMPLE',
  secretKey: 'secret-key',
  region: 'ap-shanghai',
  bucket: 'example-1250000000',
  signedUrlMinutes: 15
};

test('signed COS downloads use and sign the configured custom domain', () => {
  const url = new URL(cosSignedDownloadUrl({
    ...config,
    publicDomain: 'https://cos.example.com'
  }, 'ipa/com.example/中文 App.ipa', {
    nowSeconds: 1_700_000_000
  }));

  assert.equal(url.origin, 'https://cos.example.com');
  assert.equal(decodeURIComponent(url.pathname), '/ipa/com.example/中文 App.ipa');
  assert.equal(url.searchParams.get('q-ak'), 'AKIDEXAMPLE');
  assert.equal(url.searchParams.get('q-sign-time'), '1700000000;1700000900');
  assert.equal(url.searchParams.get('q-header-list'), 'host');
});

test('signed COS downloads fall back to the bucket default domain', () => {
  const url = new URL(cosSignedDownloadUrl(config, 'ipa/example.ipa', {
    nowSeconds: 1_700_000_000
  }));
  assert.equal(url.host, 'example-1250000000.cos.ap-shanghai.myqcloud.com');
});
