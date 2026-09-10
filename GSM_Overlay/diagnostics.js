const fs = require('node:fs');
const path = require('node:path');

// Synchronous, bounded breadcrumbs survive an immediate process exit. Callers
// supply fixed event names and numeric/status fields, never settings or text.
function createOverlayDiagnostics(directory) {
  const filename = path.join(directory, 'overlay-diagnostics.log');
  return (event, details = {}) => {
    try {
      if (fs.existsSync(filename) && fs.statSync(filename).size > 512 * 1024) {
        fs.copyFileSync(filename, `${filename}.previous`);
        fs.truncateSync(filename, 0);
      }
      fs.appendFileSync(filename, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`);
    } catch (_) { /* Diagnostics must never change overlay behavior. */ }
  };
}

module.exports = { createOverlayDiagnostics };
