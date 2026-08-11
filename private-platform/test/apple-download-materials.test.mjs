import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeDownloadMaterialsShape,
  normalizeAppleDownloadMaterials
} from '../apple-download-materials.mjs';

test('normalizes IPA-Download style songList assets and metadata', () => {
  const normalized = normalizeAppleDownloadMaterials({
    songList: [{
      assets: [{ URL: 'https://cdn.example.com/app.ipa' }],
      metadata: {
        itemId: 414478124,
        itemName: '微信',
        softwareVersionBundleId: 'com.tencent.xin',
        bundleShortVersionString: '8.0.75',
        softwareVersionExternalIdentifier: 886775900,
        softwareVersionExternalIdentifiers: [886775900, 885566473],
        fileSizeBytes: '811800000'
      },
      sinfs: [{ id: 'main', sinf: 'base64-sinf' }]
    }]
  }, { version: 'fallback' });

  assert.equal(normalized.downloadURL, 'https://cdn.example.com/app.ipa');
  assert.equal(normalized.downloadUrl, 'https://cdn.example.com/app.ipa');
  assert.equal(normalized.software.name, '微信');
  assert.equal(normalized.software.id, 414478124);
  assert.equal(typeof normalized.software.id, 'number');
  assert.equal(normalized.software.bundleID, 'com.tencent.xin');
  assert.equal(normalized.software.bundleId, 'com.tencent.xin');
  assert.equal(normalized.software.version, '8.0.75');
  assert.equal(normalized.software.softwareVersionExternalIdentifier, '886775900');
  assert.deepEqual(normalized.software.softwareVersionExternalIdentifiers, ['886775900', '885566473']);
  assert.equal(normalized.software.fileSizeBytes, '811800000');
  assert.deepEqual(normalized.sinfs, [{ id: 0, sinf: 'base64-sinf' }]);
  assert.equal(normalized.iTunesMetadata.itemName, '微信');
});

test('keeps current iPhone materials shape intact', () => {
  const normalized = normalizeAppleDownloadMaterials({
    downloadURL: 'https://cdn.example.com/current.ipa',
    software: {
      id: 123,
      name: 'Current',
      bundleID: 'com.example.current',
      version: '1.2.3'
    },
    sinfs: ['sinf-data'],
    iTunesMetadata: { itemName: 'Metadata name' }
  });

  assert.equal(normalized.downloadURL, 'https://cdn.example.com/current.ipa');
  assert.equal(normalized.software.name, 'Current');
  assert.equal(normalized.software.id, 123);
  assert.equal(typeof normalized.software.id, 'number');
  assert.equal(normalized.software.bundleID, 'com.example.current');
  assert.equal(normalized.software.bundleId, 'com.example.current');
  assert.deepEqual(normalized.sinfs, [{ id: 0, sinf: 'sinf-data' }]);
});

test('merges partial material software with the complete fallback Swift payload', () => {
  const normalized = normalizeAppleDownloadMaterials({
    downloadURL: 'https://cdn.example.com/material.ipa',
    software: {
      id: '6745890963',
      bundleID: 'com.kylin.readnew'
    },
    sinfs: [{ id: '42', sinf: 'base64-sinf' }]
  }, {
    id: 6745890963,
    bundleID: 'com.kylin.readnew',
    name: '红果漫剧',
    version: '7.3.0',
    artistName: 'Example',
    formattedPrice: '免费',
    primaryGenreName: 'Entertainment',
    description: 'Description',
    artworkUrl100: 'https://example.com/icon.png',
    screenshotUrls: [],
    averageUserRating: 4.8,
    userRatingCount: 10
  });

  assert.equal(normalized.software.id, 6745890963);
  assert.equal(typeof normalized.software.id, 'number');
  assert.equal(normalized.software.bundleID, 'com.kylin.readnew');
  assert.equal(normalized.software.bundleId, 'com.kylin.readnew');
  assert.equal(normalized.software.name, '红果漫剧');
  assert.equal(normalized.software.version, '7.3.0');
  assert.deepEqual(normalized.sinfs, [{ id: 42, sinf: 'base64-sinf' }]);
});

test('describes incomplete materials shape for diagnostics', () => {
  const description = describeDownloadMaterialsShape({
    songList: [{ metadata: { itemName: 'No URL' } }]
  });

  assert.match(description, /keys=\[songList\]/);
  assert.match(description, /songKeys=\[metadata\]/);
  assert.match(description, /hasMetadata=true/);
  assert.match(description, /hasSinfs=false/);
});
