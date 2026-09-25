// SPDX-License-Identifier: LGPL-3.0-only
const fs = require('node:fs');

const MIN_YOMITAN_FREE_BYTES = 1024 ** 3;

// One filesystem metadata query on the volume that holds Chromium's Yomitan session.
function checkYomitanDiskSpace(storagePath, statfsSync = fs.statfsSync) {
  try {
    const { bsize, bavail } = statfsSync(storagePath);
    const bytesPerBlock = Number(bsize);
    const availableBlocks = Number(bavail);
    const freeBytes = bytesPerBlock * availableBlocks;
    if (bytesPerBlock <= 0 || availableBlocks < 0 || !Number.isFinite(freeBytes)) {
      return null;
    }
    return { freeBytes, isLow: freeBytes < MIN_YOMITAN_FREE_BYTES };
  } catch {
    // An unavailable reading should not prevent the overlay from starting.
    return null;
  }
}

module.exports = { MIN_YOMITAN_FREE_BYTES, checkYomitanDiskSpace };
