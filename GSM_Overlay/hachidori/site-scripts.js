// SPDX-License-Identifier: GPL-3.0-or-later

// Registers a site's content scripts while its experimental switch is on and
// unregisters them when it goes off (netflix.js, youtube.js). Each switch's
// applications are serialised like applyGoogleDocsFlag, so rapid toggles apply
// in order.
export function siteScriptSwitch(scripts) {
  const ids = scripts.map(script => script.id);
  let application = Promise.resolve();

  async function apply(browser, enabled) {
    const scripting = browser.scripting;
    if (typeof scripting?.registerContentScripts !== "function") return { supported: false, registered: false };
    const existing = new Set((await scripting.getRegisteredContentScripts({ ids })).map(script => script.id));
    if (!enabled) {
      if (existing.size > 0) await scripting.unregisterContentScripts({ ids: [...existing] });
      return { supported: true, registered: false };
    }
    const missing = scripts.filter(script => !existing.has(script.id));
    if (missing.length > 0) await scripting.registerContentScripts(missing);
    return { supported: true, registered: true };
  }

  return (browser, enabled) => {
    application = application.catch(() => {}).then(() => apply(browser, enabled));
    return application;
  };
}
