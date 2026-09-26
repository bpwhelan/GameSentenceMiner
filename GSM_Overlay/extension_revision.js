const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Fork changes often keep the upstream manifest version (and packaged mtime).
// Hash the actual bundle so Chromium cannot reuse an older background worker.
function getExtensionContentRevision(directory) {
  const hash = createHash('sha256');
  function visit(relativeDirectory) {
    const entries = fs.readdirSync(path.join(directory, relativeDirectory), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile()) {
        const content = fs.readFileSync(path.join(directory, relativePath));
        hash.update(`${relativePath}\0${content.length}\0`);
        hash.update(content);
      }
    }
  }
  visit('');
  return hash.digest('hex');
}

module.exports = { getExtensionContentRevision };
