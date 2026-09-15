/* SPDX-License-Identifier: GPL-3.0-or-later */

const text = node => node?.textContent.replace(/\s+/g, " ").trim() || "";
const normalise = value => value.normalize("NFKC").toLocaleLowerCase();

export function createSettingsSearch({ document, navigate }) {
  const input = document.getElementById("settings-search");
  const panel = document.getElementById("settings-search-results");
  const results = document.getElementById("settings-search-matches");
  const count = document.getElementById("settings-search-count");

  function clear() {
    input.value = "";
    panel.hidden = true;
    results.replaceChildren();
  }

  function appendResult(section, target, sectionName, sectionGroup, group, label, hint) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `#${section.id}`;
    const breadcrumb = document.createElement("small");
    const sectionPath = sectionGroup ? `${sectionGroup} › ${sectionName}` : sectionName;
    let breadcrumbText = sectionGroup && label === sectionName ? sectionGroup : sectionPath;
    if (group && group !== label) breadcrumbText = `${sectionPath} › ${group}`;
    breadcrumb.textContent = breadcrumbText;
    const title = document.createElement("strong");
    title.textContent = label;
    link.append(breadcrumb, title);
    if (hint) {
      const detail = document.createElement("span");
      detail.textContent = hint;
      link.append(detail);
    }
    link.addEventListener("click", event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(section.id);
      let destination = target;
      for (let parent = target; parent && parent !== section; parent = parent.parentElement) {
        // Conditional settings stay governed by their own enable control.
        // Lead to the enclosing group when the matching control is hidden.
        if (parent.hidden) destination = parent.parentElement;
        else if (parent.tagName === "DETAILS") parent.open = true;
      }
      const controls = [destination.control, ...destination.querySelectorAll("input, select, textarea, button")];
      const control = controls.find(node => node && !node.disabled && !node.closest("[hidden]")) || destination;
      if (!control.matches("input, select, textarea, button, summary, a[href], [tabindex]")) control.tabIndex = -1;
      control.focus({ preventScroll: true });
      destination.scrollIntoView({ block: "center" });
    });
    item.append(link);
    results.append(item);
  }

  function searchSection(section, words) {
    section.hidden = true;
    const sectionName = section.dataset.settingsName || text(section.querySelector("h1"));
    const sectionGroup = section.dataset.settingsGroup || "";
    // Read mounted labels on demand, including lazy controls once populated.
    const candidates = section.querySelectorAll("h1, h2, h3, legend, summary, label, button[id]");
    for (const target of candidates) {
      if (target.closest("template, [role=status], output")) continue;
      const label = text(target.querySelector(".field-label"))
        || text(target.querySelector("span")) || text(target);
      if (!label) continue;
      const group = text(target.closest("fieldset")?.querySelector("legend"));
      const hint = text(target.querySelector(".field-hint"));
      const searchable = normalise(`${sectionGroup} ${sectionName} ${group} ${label} ${hint} ${target.dataset.searchKeywords || ""}`);
      if (!words.every(word => searchable.includes(word))) continue;
      appendResult(section, target, sectionName, sectionGroup, group, label, hint);
    }
  }

  function search() {
    const words = normalise(input.value.trim()).split(/\s+/).filter(Boolean);
    if (!words.length) { navigate(); return; }
    results.replaceChildren();
    panel.hidden = false;
    document.getElementById("library-navigation").hidden = true;
    for (const section of document.querySelectorAll("main > section")) searchSection(section, words);
    const matches = results.childElementCount;
    const noun = matches === 1 ? "setting" : "settings";
    count.textContent = matches ? `${matches} ${noun} found` : "No settings found. Try another word.";
  }

  input.addEventListener("input", search);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); navigate(); input.focus(); }
    if (event.key === "ArrowDown") { event.preventDefault(); results.querySelector("a")?.focus(); }
  });
  results.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); navigate(); input.focus(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = [...results.querySelectorAll("a")];
    const index = links.indexOf(event.target.closest("a"));
    if (index < 0) return;
    event.preventDefault();
    if (event.key === "ArrowUp") (links[index - 1] || input).focus();
    else links[Math.min(index + 1, links.length - 1)].focus();
  });
  return { clear };
}
