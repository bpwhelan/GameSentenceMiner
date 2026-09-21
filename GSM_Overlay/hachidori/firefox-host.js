// Persistent Firefox background-page host for the hidden engine iframe.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  extensionApi,
  extensionDocumentUrl,
  IS_FIREFOX,
  isExactExtensionSender,
} from "./browser-api.js";

const TARGET = "hachidori-firefox-host";
const OFFSCREEN_DOCUMENT = "offscreen.html";
const BACKGROUND_DOCUMENT = "firefox-background.html";
const READY_TIMEOUT_MS = 10_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OFFSCREEN_INSTANCE_ID = globalThis.crypto.randomUUID();

let ready = false;
let readyDetails = null;
let settleReady;
let rejectReady;
const readyPromise = new Promise((resolve, reject) => {
  settleReady = resolve;
  rejectReady = reject;
});
let readyTimer = null;

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function clearReadyTimer() {
  if (readyTimer === null) return;
  clearTimeout(readyTimer);
  readyTimer = null;
}

function failReady(error) {
  if (ready) return;
  clearReadyTimer();
  rejectReady(error instanceof Error ? error : new Error(String(error)));
}

function assertReadyMessage(message, sender) {
  if (!isExactExtensionSender(sender, OFFSCREEN_DOCUMENT, extensionApi, { tab: false })) {
    throw new Error("Firefox engine readiness came from an untrusted document.");
  }
  if (message.extensionId !== extensionApi.runtime.id
      || message.documentUrl !== extensionDocumentUrl(OFFSCREEN_DOCUMENT)
      || !UUID_V4.test(message.instanceId)) {
    throw new Error("Firefox engine readiness carried the wrong extension identity.");
  }
}

function hostReply() {
  return {
    ok: true,
    extensionId: extensionApi.runtime.id,
    backgroundUrl: extensionDocumentUrl(BACKGROUND_DOCUMENT),
    offscreenUrl: extensionDocumentUrl(OFFSCREEN_DOCUMENT),
    instanceId: readyDetails?.instanceId ?? null,
  };
}

export function createFirefoxBackgroundHost(document) {
  if (!IS_FIREFOX) throw new Error("The Firefox background host can run only in Firefox.");
  let iframe = null;

  extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== TARGET) return false;
    try {
      if (message.type === "hd_firefox_offscreen_ready") {
        assertReadyMessage(message, sender);
        ready = true;
        readyDetails = {
          extensionId: sender.id,
          documentUrl: sender.url,
          backgroundUrl: extensionDocumentUrl(BACKGROUND_DOCUMENT),
          instanceId: message.instanceId,
        };
        clearReadyTimer();
        settleReady(readyDetails);
        sendResponse(hostReply());
        return false;
      }
      if (message.type === "hd_firefox_host_status") {
        if (sender?.id !== extensionApi.runtime.id) {
          throw new Error("Firefox host status came from another extension.");
        }
        sendResponse({ ...hostReply(), ready, details: readyDetails });
        return false;
      }
      throw new Error("Unknown Firefox host request.");
    } catch (error) {
      sendResponse({ ok: false, error: describe(error) });
      return false;
    }
  });

  return {
    mount() {
      if (iframe !== null) return iframe;
      iframe = document.createElement("iframe");
      iframe.id = "hachidori-firefox-engine";
      iframe.src = extensionDocumentUrl(OFFSCREEN_DOCUMENT);
      iframe.hidden = true;
      iframe.setAttribute("aria-hidden", "true");
      iframe.addEventListener("error", () => {
        failReady(new Error("Firefox could not load the hidden dictionary engine."));
      }, { once: true });
      document.body.append(iframe);
      readyTimer = setTimeout(() => {
        failReady(new Error("Firefox did not start the hidden dictionary engine."));
      }, READY_TIMEOUT_MS);
      return iframe;
    },
  };
}

export async function waitForFirefoxOffscreen() {
  if (!IS_FIREFOX) return null;
  return readyPromise;
}

export async function announceFirefoxOffscreen() {
  if (!IS_FIREFOX) return null;
  const documentUrl = globalThis.location?.href;
  if (documentUrl !== extensionDocumentUrl(OFFSCREEN_DOCUMENT)) {
    throw new Error("Firefox loaded the dictionary engine from an unexpected URL.");
  }
  const reply = await extensionApi.runtime.sendMessage({
    target: TARGET,
    type: "hd_firefox_offscreen_ready",
    extensionId: extensionApi.runtime.id,
    documentUrl,
    instanceId: OFFSCREEN_INSTANCE_ID,
  });
  if (!reply?.ok
      || reply.extensionId !== extensionApi.runtime.id
      || reply.backgroundUrl !== extensionDocumentUrl(BACKGROUND_DOCUMENT)
      || reply.offscreenUrl !== documentUrl
      || reply.instanceId !== OFFSCREEN_INSTANCE_ID) {
    throw new Error(reply?.error || "Firefox background authentication failed.");
  }
  return reply;
}
