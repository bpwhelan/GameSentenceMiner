// SPDX-License-Identifier: GPL-3.0-or-later

const SCRIPT_ID = "hachidori-custom-javascript";
let application = Promise.resolve();

// Chrome MV3 `userScripts` registration. Firefox MV2 has no `userScripts`
// with a USER_SCRIPT world, so the saved code stays inert there and Settings
// hides the editor through HOST_CAPABILITIES.customJavaScript.
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
    js: [{ code }],
    runAt: "document_idle",
    world: "USER_SCRIPT",
  }]);
  return { supported: true, registered: true };
}

export function applyCustomJavaScript(browser, code) {
  application = application.catch(() => {}).then(() => apply(browser, code));
  return application;
}
