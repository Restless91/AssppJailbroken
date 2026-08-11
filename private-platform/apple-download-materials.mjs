function firstObject(value) {
  if (Array.isArray(value)) return value.find((item) => item && typeof item === 'object') || null;
  return value && typeof value === 'object' ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function firstInteger(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return 0;
}

function normalizeSoftware(rawSoftware, metadata, options = {}) {
  const fallbackSoftware = firstObject(options.fallbackSoftware) || {};
  const software = {
    ...fallbackSoftware,
    ...(firstObject(rawSoftware) || {})
  };
  const preferMetadata = Boolean(options.preferMetadata);
  const versionIds = Array.isArray(software.softwareVersionExternalIdentifiers)
    ? software.softwareVersionExternalIdentifiers
    : Array.isArray(metadata?.softwareVersionExternalIdentifiers)
      ? metadata.softwareVersionExternalIdentifiers
      : [];
  const externalVersionId = firstString(
    software.externalVersionId,
    software.softwareVersionExternalIdentifier,
    metadata?.softwareVersionExternalIdentifier
  );
  return {
    ...software,
    id: firstInteger(
      software.id,
      software.trackId,
      metadata?.itemId,
      metadata?.softwareVersionId,
      fallbackSoftware.id,
      fallbackSoftware.trackId
    ),
    name: preferMetadata
      ? firstString(metadata?.itemName, metadata?.bundleDisplayName, software.name, software.trackName)
      : firstString(software.name, software.trackName, metadata?.itemName, metadata?.bundleDisplayName),
    bundleID: firstString(
      software.bundleID,
      software.bundleId,
      software.bundleIdentifier,
      metadata?.softwareVersionBundleId,
      metadata?.bundleIdentifier,
      metadata?.CFBundleIdentifier,
      fallbackSoftware.bundleID,
      fallbackSoftware.bundleId
    ),
    version: preferMetadata
      ? firstString(metadata?.bundleShortVersionString, metadata?.CFBundleShortVersionString, software.version, software.bundleShortVersionString)
      : firstString(software.version, software.bundleShortVersionString, metadata?.bundleShortVersionString, metadata?.CFBundleShortVersionString),
    fileSizeBytes: preferMetadata
      ? firstString(metadata?.fileSizeBytes, metadata?.softwareVersionFileSize, software.fileSizeBytes, software.size)
      : firstString(software.fileSizeBytes, software.size, metadata?.fileSizeBytes, metadata?.softwareVersionFileSize),
    externalVersionId,
    softwareVersionExternalIdentifier: firstString(software.softwareVersionExternalIdentifier, externalVersionId),
    softwareVersionExternalIdentifiers: versionIds.map((value) => String(value)).filter(Boolean)
  };
}

function normalizeSinfEntry(entry, index) {
  if (typeof entry === 'string' && entry.trim()) {
    return { id: index, sinf: entry.trim() };
  }
  if (!entry || typeof entry !== 'object') return null;
  const sinf = firstString(entry.sinf, entry.SINF, entry.data, entry.signature);
  if (!sinf) return null;
  return {
    ...entry,
    id: firstInteger(entry.id, index),
    sinf
  };
}

function normalizeSinfs(...candidates) {
  for (const candidate of candidates) {
    const values = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
    const sinfs = values.map(normalizeSinfEntry).filter(Boolean);
    if (sinfs.length) return sinfs;
  }
  return [];
}

export function normalizeAppleDownloadMaterials(rawMaterials, fallbackSoftware = {}) {
  const materials = firstObject(rawMaterials) || {};
  const song = firstObject(materials.songList) || firstObject(materials.songs) || firstObject(materials.song);
  const asset = firstObject(materials.asset)
    || firstObject(materials.assets)
    || firstObject(materials.download)
    || firstObject(song?.asset)
    || firstObject(song?.assets);
  const metadata = firstObject(materials.iTunesMetadata)
    || firstObject(materials.metadata)
    || firstObject(materials.iTunesMetadataPlist)
    || firstObject(song?.metadata)
    || null;
  const downloadURL = firstString(
    materials.downloadURL,
    materials.downloadUrl,
    materials['download-url'],
    materials.url,
    materials.URL,
    materials.assetURL,
    materials.assetUrl,
    materials.download?.downloadURL,
    materials.download?.downloadUrl,
    materials.download?.url,
    materials.download?.URL,
    asset?.downloadURL,
    asset?.downloadUrl,
    asset?.['download-url'],
    asset?.url,
    asset?.URL,
    asset?.assetURL,
    asset?.assetUrl,
    song?.downloadURL,
    song?.downloadUrl,
    song?.url,
    song?.URL
  );
  const materialSoftware = materials.software || song?.software;
  const software = normalizeSoftware(materialSoftware || {}, metadata, {
    preferMetadata: !materialSoftware,
    fallbackSoftware
  });
  software.bundleId = software.bundleID;
  const sinfs = normalizeSinfs(materials.sinfs, materials.sinf, materials.signature, song?.sinfs, song?.sinf, song?.signature);

  return {
    ...materials,
    downloadURL,
    downloadUrl: downloadURL,
    sinfs,
    iTunesMetadata: materials.iTunesMetadata || metadata,
    metadata: materials.metadata || metadata,
    software
  };
}

export function describeDownloadMaterialsShape(rawMaterials) {
  const materials = firstObject(rawMaterials) || {};
  const song = firstObject(materials.songList) || firstObject(materials.songs) || firstObject(materials.song);
  const asset = firstObject(materials.asset)
    || firstObject(materials.assets)
    || firstObject(materials.download)
    || firstObject(song?.asset)
    || firstObject(song?.assets);
  const keys = Object.keys(materials).sort();
  const songKeys = song ? Object.keys(song).sort() : [];
  const assetKeys = asset ? Object.keys(asset).sort() : [];
  const hasMetadata = Boolean(firstObject(materials.iTunesMetadata) || firstObject(materials.metadata) || firstObject(song?.metadata));
  const hasSinfs = normalizeSinfs(materials.sinfs, materials.sinf, materials.signature, song?.sinfs, song?.sinf, song?.signature).length > 0;
  return `keys=[${keys.join(',') || 'none'}] songKeys=[${songKeys.join(',') || 'none'}] assetKeys=[${assetKeys.join(',') || 'none'}] hasMetadata=${hasMetadata} hasSinfs=${hasSinfs}`;
}
