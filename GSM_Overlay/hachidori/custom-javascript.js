// SPDX-License-Identifier: GPL-3.0-or-later

const SCRIPT_ID = "hachidori-custom-javascript";
let application = Promise.resolve();

async function apply(browser, code) {
  let scripts;
  try {
    scripts = browser.userScripts;
    await scripts.getScripts({ ids: [SCRIPT_ID] });
  } catch {
    return;
  }
  await scripts.unregister({ ids: [SCRIPT_ID] }).catch(() => {});
  if (code === "") return;
  await scripts.register([{
    id: SCRIPT_ID,
    matches: ["<all_urls>"],
    js: [{ code }],
    runAt: "document_idle",
    world: "USER_SCRIPT",
  }]);
}

export function applyCustomJavaScript(browser, code) {
  application = application.catch(() => {}).then(() => apply(browser, code));
  return application;
}