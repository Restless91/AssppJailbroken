export function evaluateDeviceDecryptReadiness(device, requirements = {}) {
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
  if (requirements.resumableBatches === true && capabilities.resumableBatches === false) {
    return { ready: false, code: 'resumable_batches_unavailable' };
  }
  if (requirements.extensionPolicy === 'strict'
    && Array.isArray(capabilities.extensionPolicies)
    && !capabilities.extensionPolicies.includes('strict')) {
    return { ready: false, code: 'strict_extension_policy_unavailable' };
  }
  return { ready: true, code: null };
}
