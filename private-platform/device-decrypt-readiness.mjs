export function evaluateDeviceDecryptReadiness(device) {
  const capabilities = device?.capabilities;
  if (!capabilities || Object.keys(capabilities).length === 0) {
    return { ready: true, code: null };
  }
  if (capabilities.externalURLDownload === false) {
    return { ready: false, code: 'external_url_download_unavailable' };
  }
  if (capabilities.appinstInstall === false && capabilities.trollStoreInstall === false) {
    return { ready: false, code: 'ipa_install_provider_unavailable' };
  }
  return { ready: true, code: null };
}
