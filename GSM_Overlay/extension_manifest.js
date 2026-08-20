function parseExtensionManifest(manifestText) {
  return JSON.parse(manifestText.replace(/^\uFEFF/, ''));
}

module.exports = { parseExtensionManifest };
