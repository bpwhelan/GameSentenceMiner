// SPDX-License-Identifier: GPL-3.0-or-later

// The text a caught error or rejection reason gives a log line, a status
// message or a reply's `error` field. The variants agree on an Error with a
// string message (its String() form when the message is empty) and on a
// string. They differ only in how they describe anything else, such as a
// plain object or an error from another realm, so each context keeps the
// variant its messages have always used.

// Anything else as String() writes it.
export function describeError(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

// Anything else as JSON.
export function describeErrorOrJson(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

// Anything else by its truthy `message`, otherwise as JSON.
export function describeErrorMessageOrJson(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  if (typeof error === "string") {
    return error;
  }
  return error?.message ? String(error.message) : JSON.stringify(error);
}

// Anything with a non-empty string `message` by that message, an Error from
// another realm included, otherwise as String() writes it.
export function describeErrorMessage(error) {
  return typeof error?.message === "string" && error.message !== "" ? error.message : String(error);
}
