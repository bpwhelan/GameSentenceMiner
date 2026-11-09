// SPDX-License-Identifier: GPL-3.0-or-later

export const SCRIPT_ID = "hachidori-custom-javascript";
let application = Promise.resolve();

// Chrome MV3 `userScripts` registration. Hosts without a USER_SCRIPT world
// leave saved code inert and hide the editor through host capabilities. The
// bridge runs first in the same world, so the saved code reaches the popup's
// closed root through host.shadowRoot (custom-javascript-bridge.js).
async function apply(browser, code) {
  let scripts;
  try {
    scripts = browser.userScripts;
    await scripts.getScripts({ ids: [SCRIPT_ID] });
  } catch {
    return { supported: false, registered: false };
  }
  await scripts.unregister({ ids: [SCRIPT_ID] }).catch(() => {});
  if (code === "") return { supported: true, registered: false };
  await scripts.register([{
    id: SCRIPT_ID,
    matches: ["<all_urls>"],
    js: [{ file: "custom-javascript-bridge.js" }, { code }],
    runAt: "document_idle",
    world: "USER_SCRIPT",
  }]);
  return { supported: true, registered: true };
}

export function applyCustomJavaScript(browser, code) {
  application = application.catch(() => {}).then(() => apply(browser, code));
  return application;
}
