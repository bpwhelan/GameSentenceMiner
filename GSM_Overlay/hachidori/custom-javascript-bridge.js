// Custom JavaScript's way into the reader's popup (#645).
//
// The popup lives in a closed shadow root, so that neither the page nor
// extensions such as Dark Reader can find and restyle it. The service worker
// registers this file ahead of the saved Custom JavaScript, in the same
// user-script world. While Custom JavaScript is saved, the reader dispatches
// `hachidori-popup-root` on its new host; this attaches the closed root from
// here and returns it through `host.shadowRoot` to these scripts and nothing
// else. The reader reads the root back through its extension API, and attaches
// its own wherever this file does not run.
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  const roots = new WeakMap();
  // Taken before the saved code runs, so a script wrapping attachShadow cannot
  // open the reader's root.
  const { attachShadow } = Element.prototype;
  const shadowRoot = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot");
  window.addEventListener("hachidori-popup-root", ({ target }) => {
    if (target.localName === "hachidori-host") roots.set(target, attachShadow.call(target, { mode: "closed" }));
  }, true);
  Object.defineProperty(Element.prototype, "shadowRoot", {
    ...shadowRoot,
    get() { return roots.get(this) ?? shadowRoot.get.call(this); },
  });
}());
