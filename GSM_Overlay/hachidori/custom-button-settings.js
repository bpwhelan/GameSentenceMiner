// SPDX-License-Identifier: GPL-3.0-or-later
import "./external-links.js";

export function validateLinkButton(label, url) {
  if (!label || /[\u0000-\u001f\u007f]/u.test(label)) return "Enter a name for the button.";
  if (!globalThis.HDExternalLinks.expandCustomLinkUrl(url, { word: "word", reading: "reading", sentence: "sentence" })) {
    return "Enter an http:// or https:// URL. %w, %r and %s are supported.";
  }
  return "";
}

// Retained for callers that validate legacy custom-link drafts directly.
export const validateCustomLink = validateLinkButton;

export function createCustomButtonSettings({
  document,
  readButtons,
  saveButtons,
  readTemplates,
  createId = () => document.defaultView.crypto.randomUUID(),
}) {
  const list = document.getElementById("custom-button-list");
  const empty = document.getElementById("custom-button-empty");
  const form = document.getElementById("custom-button-form");
  const name = document.getElementById("opt-custom-button-name");
  const type = document.getElementById("opt-custom-button-type");
  const url = document.getElementById("opt-custom-button-url");
  const template = document.getElementById("opt-custom-button-template");
  const linkField = document.getElementById("custom-button-link-field");
  const ankiField = document.getElementById("custom-button-anki-field");
  const submit = document.getElementById("custom-button-submit");
  const cancel = document.getElementById("custom-button-cancel");
  const status = document.getElementById("custom-buttons-status");
  let editing = null;
  let rendered = null;

  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const templates = () => readTemplates().filter(value => value && typeof value.id === "string");
  const templateById = id => templates().find(value => value.id === id);

  function button(text, label, onClick, iconName) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "ghost";
    if (iconName) {
      const icon = document.createElement("span");
      icon.className = "hd-icon";
      icon.dataset.icon = iconName;
      icon.setAttribute("aria-hidden", "true");
      node.append(icon);
    } else {
      node.textContent = text;
    }
    node.setAttribute("aria-label", label);
    node.addEventListener("click", onClick);
    return node;
  }

  function focusRow(index, action) {
    const row = list.children[Math.min(index, list.children.length - 1)];
    (row?.querySelector(`[data-action="${action}"]:not(:disabled)`)
      ?? row?.querySelector("button:not(:disabled)") ?? name).focus();
  }

  function move(index, offset) {
    const buttons = readButtons().slice();
    [buttons[index], buttons[index + offset]] = [buttons[index + offset], buttons[index]];
    if (editing?.index === index) editing.index += offset;
    else if (editing?.index === index + offset) editing.index -= offset;
    saveButtons(buttons);
    render();
    focusRow(index + offset, offset < 0 ? "up" : "down");
  }

  function remove(index) {
    if (editing?.index === index) closeForm();
    else if (editing && editing.index > index) editing.index -= 1;
    saveButtons(readButtons().filter((_button, buttonIndex) => buttonIndex !== index));
    render();
    focusRow(index, "edit");
  }

  function edit(index) {
    const value = readButtons()[index];
    editing = { index, button: value };
    name.value = value.label;
    type.value = value.type;
    url.value = value.type === "link" ? value.url : "";
    template.value = value.type === "anki" ? value.templateId : "";
    status.textContent = "";
    updateForm();
    name.focus();
  }

  function createRow(value, index, count) {
    const row = document.createElement("li");
    row.className = "custom-button-row";
    const text = document.createElement("div");
    text.className = "custom-button-text";
    const label = document.createElement("strong");
    label.textContent = value.label;
    const summary = document.createElement("span");
    summary.className = "custom-button-summary";
    const kind = document.createElement("span");
    kind.className = "custom-button-kind";
    kind.textContent = value.type === "link" ? "Link" : "Anki";
    const detail = document.createElement(value.type === "link" ? "code" : "span");
    if (value.type === "link") detail.textContent = value.url;
    else detail.textContent = templateById(value.templateId)?.name ?? "Template unavailable";
    summary.append(kind, " · ", detail);
    text.append(label, summary);
    const actions = document.createElement("div");
    actions.className = "custom-button-actions";
    const up = button("", `Move up: ${value.label}`, () => move(index, -1), "arrow-up");
    const down = button("", `Move down: ${value.label}`, () => move(index, 1), "arrow-down");
    up.dataset.action = "up";
    down.dataset.action = "down";
    up.disabled = index === 0;
    down.disabled = index === count - 1;
    const editButton = button("Edit", `Edit button ${value.label}`, () => edit(index));
    editButton.dataset.action = "edit";
    actions.append(up, down, editButton, button("Delete", `Delete button ${value.label}`, () => remove(index)));
    row.append(text, actions);
    return row;
  }

  function renderTemplateChoices() {
    const values = templates();
    const selected = template.value;
    const choices = values.map(value => new document.defaultView.Option(value.name, value.id));
    if (selected && !values.some(value => value.id === selected)) {
      choices.push(new document.defaultView.Option("Unavailable Template", selected));
    }
    template.replaceChildren(...choices);
    template.value = selected && choices.some(option => option.value === selected)
      ? selected : values[0]?.id ?? "";
  }

  function updateForm() {
    renderTemplateChoices();
    const link = type.value === "link";
    linkField.hidden = !link;
    ankiField.hidden = link;
    submit.textContent = editing ? "Save button" : "Add button";
    cancel.hidden = !editing;
  }

  function closeForm() {
    editing = null;
    name.value = url.value = "";
    type.value = "link";
    template.value = templates()[0]?.id ?? "";
    status.textContent = "";
    updateForm();
  }

  function render() {
    const buttons = readButtons();
    const key = JSON.stringify([buttons, templates().map(({ id, name: templateName }) => [id, templateName])]);
    if (key === rendered) return;
    rendered = key;
    list.replaceChildren(...buttons.map((value, index) => createRow(value, index, buttons.length)));
    empty.hidden = buttons.length > 0;
    renderTemplateChoices();
  }

  function uniqueId() {
    const ids = new Set(readButtons().map(value => value.id));
    let id;
    do id = createId();
    while (typeof id !== "string" || id === "" || ids.has(id));
    return id;
  }

  function draft() {
    const base = {
      id: editing?.button.id ?? "",
      type: type.value,
      label: name.value.trim(),
    };
    return type.value === "anki"
      ? { ...base, templateId: template.value }
      : { ...base, url: url.value.trim() };
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = draft();
    let error = "";
    if (value.type === "link") error = validateLinkButton(value.label, value.url);
    else if (!value.label || /[\u0000-\u001f\u007f]/u.test(value.label)) error = "Enter a name for the button.";
    else if (!templateById(value.templateId)) error = "Choose an available Template.";
    if (error) {
      status.textContent = error;
      return;
    }
    const buttons = readButtons().slice();
    if (editing && !same(buttons[editing.index], editing.button)) {
      status.textContent = "This button changed elsewhere. Cancel, then edit it again.";
      return;
    }
    if (editing) buttons[editing.index] = value;
    else buttons.push({ ...value, id: uniqueId() });
    saveButtons(buttons);
    closeForm();
    render();
    name.focus();
  });
  for (const input of [name, url, template]) {
    input.addEventListener("input", () => { status.textContent = ""; });
    input.addEventListener("change", () => { status.textContent = ""; });
  }
  type.addEventListener("change", () => {
    status.textContent = "";
    updateForm();
  });
  cancel.addEventListener("click", () => {
    closeForm();
    name.focus();
  });
  updateForm();
  render();
  return {
    render,
    reset() { closeForm(); render(); },
    dirty: () => {
      const value = draft();
      if (!editing) return value.label !== "" || (value.type === "link" ? value.url !== "" : false);
      return !same(value, editing.button);
    },
  };
}
