// The search page's clipboard monitor (#639), after Yomitan's
// (yomidevs/yomitan@ac1d839 ext/js/comm/clipboard-monitor.js and
// clipboard-reader.js). The search page polls; the offscreen document, or the
// frame in Firefox's background page, reads the clipboard for it.
// SPDX-License-Identifier: GPL-3.0-or-later

// The runtime message target the search page asks the worker, and the worker
// asks the offscreen document, to read the clipboard with. The worker declares
// its own in background-core.js, beside its other targets.
export const CLIPBOARD_TARGET = "hachidori-clipboard";

// Yomitan's interval: the next read starts this long after the last one ended.
export const CLIPBOARD_POLL_MS = 250;

// Yomitan's default maximum clipboard search length (clipboard.maximumSearchLength):
// the search page searches the start of a longer copy. Laying out a query of
// 100,000 characters held the search page for about 30 seconds in Chrome 152.
export const CLIPBOARD_SEARCH_LENGTH = 1000;

// The start of `text` that is searched: after its leading spaces, at most
// CLIPBOARD_SEARCH_LENGTH characters, cut between characters, so a character
// outside the BMP that the cut would split is left out whole. The offscreen
// document sends only this to the search page.
export function clipboardSearchText(text) {
  const start = text.trimStart();
  if (start.length <= CLIPBOARD_SEARCH_LENGTH) return start;
  const split = start.codePointAt(CLIPBOARD_SEARCH_LENGTH - 1) > 0xffff;
  return start.slice(0, split ? CLIPBOARD_SEARCH_LENGTH - 1 : CLIPBOARD_SEARCH_LENGTH);
}

// Reads the clipboard through `read` until stopped and calls `change` with
// each new text, trimmed. The first read is where it starts, so text that was
// on the clipboard before is not reported; a failed or empty read reports
// nothing.
export function createClipboardMonitor({ read, change, interval = CLIPBOARD_POLL_MS, scope = globalThis }) {
  let token = null;
  let timer = null;
  let previous = null;

  function stop() {
    token = null;
    previous = null;
    if (timer !== null) scope.clearTimeout(timer);
    timer = null;
  }

  function start() {
    stop();
    // A read that ends after stop() or another start() is dropped.
    const own = {};
    let canChange = false;
    token = own;
    const tick = async () => {
      timer = null;
      let text = null;
      try {
        text = await read();
      } catch {
        // As in Yomitan: a read that fails is no text.
      }
      if (token !== own) return;
      if (typeof text === "string" && (text = text.trim()) !== "" && text !== previous) {
        previous = text;
        if (canChange) change(text);
      }
      canChange = true;
      timer = scope.setTimeout(tick, interval);
    };
    void tick();
  }

  return { start, stop, get running() { return token !== null; } };
}

// Yomitan's ClipboardReader.getText. Chrome reads by pasting into a text area
// of this document, which needs neither focus nor a prompt once Hachidori has
// the clipboardRead permission, where navigator.clipboard.readText() needs
// both. The text comes from the paste event, which is cancelled so the text
// area stays empty: laying out 300,000 pasted characters took 16-34 seconds.
// Firefox's paste command sometimes fails (Mozilla bug 1603985), so it reads
// with navigator.clipboard.readText().
export async function readClipboardText({ document, navigator, firefox }) {
  if (firefox) return navigator.clipboard.readText();
  const target = document.body.appendChild(document.createElement("textarea"));
  let text = "";
  target.addEventListener("paste", (event) => {
    text = event.clipboardData.getData("text/plain");
    event.preventDefault();
  });
  try {
    target.focus();
    document.execCommand("paste");
    return text;
  } finally {
    target.remove();
  }
}
