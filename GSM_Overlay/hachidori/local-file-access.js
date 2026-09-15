// Chrome's file-URL switch is controlled by the user in extension details.
// SPDX-License-Identifier: GPL-3.0-or-later

export function createLocalFileAccessController({ document, container, chromeApi = globalThis.chrome, onDismiss = null }) {
  const window = document.defaultView;
  const make = (tag, id, text, className = "") => {
    const node = document.createElement(tag);
    node.id = id;
    node.textContent = text;
    node.className = className;
    return node;
  };
  const heading = make("h2", "local-file-heading", "Read saved pages too");
  const description = make("p", "local-file-description",
    "To look up Japanese in HTML files opened from your computer, enable “Allow access to file URLs” in Hachidori’s extension settings.");
  const instruction = make("p", "local-file-instruction",
    "Turn on “Allow access to file URLs”, then return to this tab.");
  const recovery = make("p", "local-file-recovery", onDismiss
    ? "Chrome may close setup when it reloads Hachidori. On the extension details page, open Extension options, then choose Resume setup."
    : "Chrome may close Settings when it reloads Hachidori. On the extension details page, open Extension options to return.");
  const status = make("output", "local-file-status", "");
  status.setAttribute("role", "status");
  status.tabIndex = -1;
  const actions = make("div", "local-file-actions", "", "local-file-actions");
  const open = make("button", "local-file-open", "Open extension settings", "ghost");
  open.type = "button";
  actions.append(open);
  let skip;
  if (onDismiss) {
    skip = make("button", "local-file-skip", "Not now", "ghost");
    skip.type = "button";
    actions.append(skip);
  }
  container.classList.add("local-file-access");
  container.setAttribute("aria-labelledby", heading.id);
  container.replaceChildren(heading, description, actions, instruction, recovery, status);
  container.hidden = true;

  let allowed = null, opened = false, error = "", dismissed = false, disposed = false;
  let sequence = 0, opening = false;

  function render() {
    const enabled = allowed === true;
    const hideActions = enabled && Boolean(onDismiss);
    const focusedAction = actions.contains(document.activeElement);
    container.hidden = dismissed;
    heading.hidden = enabled;
    description.hidden = enabled;
    instruction.hidden = !opened || enabled;
    recovery.hidden = instruction.hidden;
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
    catch { nextError = "Could not check local-file access. You can check it in Chrome’s extension settings."; }
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
    try { await chromeApi.tabs.create({ url: `chrome://extensions/?id=${chromeApi.runtime.id}` }); }
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
  open.addEventListener("click", openSettings);
  skip?.addEventListener("click", dismiss);
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("pageshow", visible);
  void refresh();

  return {
    refresh,
    destroy() {
      disposed = true;
      open.removeEventListener("click", openSettings);
      skip?.removeEventListener("click", dismiss);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", visible);
    },
  };
}
