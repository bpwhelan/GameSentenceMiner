// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  const backgrounds = [
    { file: "preview-background.webp" },
    { file: "preview-background-2.webp" },
    { file: "preview-background-3.webp" },
    { file: "preview-background-4.webp", dark: true },
    { file: "preview-background-5.webp" },
    { file: "preview-background-6.webp", dark: true },
  ];

  function initialize(scene) {
    let index = crypto.getRandomValues(new Uint32Array(1))[0] % backgrounds.length;
    const show = () => {
      const background = backgrounds[index];
      scene.style.setProperty("--vn-background", `url("assets/${background.file}")`);
      scene.classList.toggle("vn-dark-dialogue", background.dark === true);
    };
    const next = scene.ownerDocument.createElement("button");
    next.type = "button";
    next.className = "vn-next";
    next.dataset.focusKey = "next-background";
    next.title = "Next background";
    next.setAttribute("aria-label", "Next background");
    next.textContent = "→";
    next.addEventListener("click", () => {
      index = (index + 1) % backgrounds.length;
      show();
    });
    show();
    scene.append(next);
  }

  globalThis.HDVisualNovel = { initialize };
}());
