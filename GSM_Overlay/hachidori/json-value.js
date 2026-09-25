/*
 * Exact structural comparison for storage values shared by the service worker
 * and engine worker transaction boundaries.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function sameJsonValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) =>
      Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
}
