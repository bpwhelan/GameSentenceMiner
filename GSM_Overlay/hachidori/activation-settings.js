// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Reading → Activation → Activation key or button. The list offers
// No key first, as Yomitan's "Scan modifier key" does, then every supported
// input. Press to set arms a one-shot capture of the next key or mouse button
// pressed anywhere on the page, after the keybind recorder but for one
// activation name rather than an event.code chord. A recorded input selects its
// entry and goes through the picker's own change handler.

// The presses the reader cannot scan with: the primary press selects text and
// dismisses popups, and the secondary press opens the browser's menu.
const REFUSED_BUTTONS = new Map([[0, "The left mouse button"], [2, "The right mouse button"]]);

// A captured input acts only as the recorder's.
function consume(event) {
  event.preventDefault();
  event.stopPropagation();
}

export function createActivationSettings({ document, report }) {
  const window = document.defaultView;
  const { ACTIVATION_BUTTONS, ACTIVATION_KEYS, normaliseActivationKey } = window.HDReaderOptions;
  const buttonKeys = new Map([...ACTIVATION_BUTTONS].map(([key, { button }]) => [button, key]));
  const select = document.getElementById("opt-activation-key");
  const recorder = document.getElementById("opt-activation-record");
  const idleLabel = recorder.textContent;
  let armed = false;
  // The button whose release, click and menu the recorder's press keeps from acting.
  let consumedButton = null;

  // `activationKey` is "" for No key.
  function render(activationKey) {
    if (select.options.length === 0) {
      const buttons = document.createElement("optgroup");
      buttons.label = "Mouse buttons";
      const keys = document.createElement("optgroup");
      keys.label = "Keys";
      for (const key of ACTIVATION_KEYS) {
        const button = ACTIVATION_BUTTONS.get(key);
        (button ? buttons : keys).append(new window.Option(button?.name ?? key, key));
      }
      select.append(new window.Option("No key", ""), buttons, keys);
    }
    if (select !== document.activeElement) select.value = activationKey;
  }

  function arm(value) {
    armed = value;
    recorder.textContent = value ? "Press a key or button…" : idleLabel;
    recorder.setAttribute("aria-pressed", String(value));
  }

  function record(key) {
    arm(false);
    select.value = key;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  }

  function refuse(name) {
    arm(false);
    report(`${name} cannot be used to scan.`);
  }

  // Escape cancels; it stays selectable from the list.
  function onKeyDown(event) {
    if (!armed) return;
    consume(event);
    if (event.repeat) return;
    if (event.key === "Escape") {
      arm(false);
      return;
    }
    const key = normaliseActivationKey(event.key, null);
    if (key) record(key);
    else refuse(event.key);
  }

  // A primary press elsewhere cancels and keeps its click; one on the recorder
  // is left to the recorder's own click.
  function onMouseDown(event) {
    consumedButton = null;
    if (!armed || (event.button === 0 && recorder.contains(event.target))) return;
    if (event.button === 0) {
      refuse(REFUSED_BUTTONS.get(0));
      return;
    }
    consume(event);
    consumedButton = event.button;
    const key = buttonKeys.get(event.button);
    if (key) record(key);
    else refuse(REFUSED_BUTTONS.get(event.button) ?? `Mouse button ${event.button + 1}`);
  }

  // Back and Forward navigate on release, the middle click opens a link in a
  // new tab and the secondary press opens the menu.
  function onConsumedEvent(event) {
    if (event.button === consumedButton) consume(event);
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("mousedown", onMouseDown, true);
  for (const type of ["mouseup", "auxclick", "contextmenu"]) window.addEventListener(type, onConsumedEvent, true);
  window.addEventListener("blur", () => { if (armed) arm(false); });
  recorder.addEventListener("click", () => {
    if (armed) refuse(REFUSED_BUTTONS.get(0));
    else arm(true);
  });
  return { render };
}
