export interface InstallInfo {
  installUrl: string;
  manifestUrl: string;
}

export function getInstallInfo(id: string): InstallInfo {
  const baseUrl = window.location.origin;
  const manifestUrl = `${baseUrl}/api/install/${id}/manifest.plist`;
  const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
  return { installUrl, manifestUrl };
}
