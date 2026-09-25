// SPDX-License-Identifier: LGPL-3.0-only
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MIN_YOMITAN_FREE_BYTES,
  checkYomitanDiskSpace,
} = require('../yomitan_disk_space');

test('blocks Yomitan below 1 GiB of available space on its storage volume', () => {
  const storagePath = 'C:\\Users\\Test\\AppData\\Roaming\\gsm_overlay';
  const queriedPaths = [];
  const result = checkYomitanDiskSpace(storagePath, (queriedPath) => {
    queriedPaths.push(queriedPath);
    return { bsize: 4096, bavail: 100, bfree: 1_000_000 };
  });

  assert.deepEqual(queriedPaths, [storagePath]);
  assert.deepEqual(result, { freeBytes: 409_600, isLow: true });
});

test('allows Yomitan at the free-space threshold', () => {
  const result = checkYomitanDiskSpace('C:\\gsm_overlay', () => ({
    bsize: 4096,
    bavail: MIN_YOMITAN_FREE_BYTES / 4096,
  }));

  assert.deepEqual(result, { freeBytes: MIN_YOMITAN_FREE_BYTES, isLow: false });
});

test('does not block Yomitan when the filesystem cannot report free space', () => {
  assert.equal(checkYomitanDiskSpace('C:\\gsm_overlay', () => {
    throw new Error('unsupported filesystem');
  }), null);
  assert.equal(checkYomitanDiskSpace('C:\\gsm_overlay', () => ({
    bsize: 0,
    bavail: NaN,
  })), null);
});
