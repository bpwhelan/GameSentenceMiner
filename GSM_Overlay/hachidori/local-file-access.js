// File-URL access is controlled by the user in browser-owned extension details.
// SPDX-License-Identifier: GPL-3.0-or-later

export function createLocalFileAccessController({
  document,
  container,
  chromeApi = globalThis.browser ?? globalThis.chrome,
  onDismiss = null,
}) {
  const window = document.defaultView;
  const firefox = (() => {
    try {
      return new URL(chromeApi.runtime.getURL("")).protocol === "moz-extension:";
    } catch {
      return false;
    }
  })();
  // Setup shows this section with a dismiss action; Settings shows it without.
  const surface = onDismiss ? "setup" : "Settings";
  // Firefox refuses tabs.create for about:addons and has no API that opens the
  // Add-ons Manager for a full-tab options page, so it gets the exact manual
  // path instead of an Open button.
  const COPY = {
    firefox: {
      browserName: "Firefox",
      description: "allow Hachidori to access local files in Firefox’s Add-ons Manager.",
      instruction: "Open about:addons, choose Hachidori, open the Permissions and data tab,"
        + " turn on “Access local files on your computer”, then return to this tab.",
      reopen: null,
      settingsUrl: null,
    },
    chrome: {
      browserName: "Chrome",
      description: "enable “Allow access to file URLs” in Hachidori’s extension settings.",
      instruction: "Turn on “Allow access to file URLs”, then return to this tab.",
      reopen: "On the extension details page, open Extension options",
      settingsUrl: () => `chrome://extensions/?id=${chromeApi.runtime.id}`,
    },
  }[firefox ? "firefox" : "chrome"];
  const { browserName } = COPY;
  const canOpenSettings = COPY.settingsUrl !== null;
  const make = (tag, id, text, className = "") => {
    const node = document.createElement(tag);
    node.id = id;
    node.textContent = text;
    node.className = className;
    return node;
  };
  const heading = make("h2", "local-file-heading", "Read saved pages too");
  const description = make("p", "local-file-description",
    `To look up Japanese in HTML files opened from your computer, ${COPY.description}`);
  const instruction = make("p", "local-file-instruction", COPY.instruction);
  let recovery = null;
  if (canOpenSettings) {
    const returnPath = onDismiss ? ", then choose Resume setup." : " to return.";
    recovery = make("p", "local-file-recovery",
      `${browserName} may close ${surface} when it reloads Hachidori. ${COPY.reopen}${returnPath}`);
  }
  const status = make("output", "local-file-status", "");
  status.setAttribute("role", "status");
  status.tabIndex = -1;
  const actions = make("div", "local-file-actions", "", "local-file-actions");
  let open;
  if (canOpenSettings) {
    open = make("button", "local-file-open", "Open extension settings", "ghost");
    open.type = "button";
    actions.append(open);
  }
  let skip;
  if (onDismiss) {
    skip = make("button", "local-file-skip", "Not now", "ghost");
    skip.type = "button";
    actions.append(skip);
  }
  container.classList.add("local-file-access");
  container.setAttribute("aria-labelledby", heading.id);
  container.replaceChildren(...[heading, description, actions, instruction, recovery, status].filter(Boolean));
  container.hidden = true;

  let allowed = null, opened = false, error = "", dismissed = false, disposed = false;
  let sequence = 0, opening = false;

  function render() {
    const enabled = allowed === true;
    const hideActions = (enabled && Boolean(onDismiss)) || actions.childElementCount === 0;
    const focusedAction = actions.contains(document.activeElement);
    container.hidden = dismissed;
    heading.hidden = enabled;
    description.hidden = enabled;
    // Without an Open button the manual path is the only path, so it shows at once.
    instruction.hidden = (canOpenSettings && !opened) || enabled;
    if (recovery) recovery.hidden = instruction.hidden;
    actions.hidden = hideActions;
    container.classList.toggle("is-enabled", enabled);
    const message = enabled ? "Local-file lookups enabled" : error;
    if (status.textContent !== message) status.textContent = message;
    if (hideActions && focusedAction) status.focus();
  }

  async function refresh() {
    if (disposed || dismissed) return;
    const request = ++sequence;
    let nextAllowed = null, nextError = "";
    try { nextAllowed = await chromeApi.extension.isAllowedFileSchemeAccess(); }
    catch { nextError = `Could not check local-file access. You can check it in ${browserName}’s extension settings.`; }
    if (disposed || dismissed || request !== sequence) return;
    allowed = nextAllowed;
    error = nextError;
    render();
  }

  async function openSettings() {
    if (opening) return;
    opening = true;
    opened = true;
    error = "";
    render();
    try {
      await chromeApi.tabs.create({
        url: COPY.settingsUrl(),
      });
    }
    catch {
      if (!disposed && !dismissed) {
        error = "Could not open extension settings. Try again.";
        render();
      }
    } finally { opening = false; }
  }

  function dismiss() {
    dismissed = true;
    container.hidden = true;
    onDismiss();
  }
  function visible() {
    if (document.visibilityState === "visible") void refresh();
  }
  open?.addEventListener("click", openSettings);
  skip?.addEventListener("click", dismiss);
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("pageshow", visible);
  void refresh();

  return {
    refresh,
    destroy() {
      disposed = true;
      open?.removeEventListener("click", openSettings);
      skip?.removeEventListener("click", dismiss);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", visible);
    },
  };
}
