// The search page's Anki Template switch (#656), where Yomitan's search page
// has its profile switch (yomidevs/yomitan@ac1d839 ext/search.html and
// ext/js/display/search-display-controller.js, _updateProfileSelect). It
// chooses the Template the built-in Anki button uses, which is the first
// Template, as Settings → Anki → Set built-in does. search.html shows the
// switch over its frame's header, where the frame lays out the same list
// invisibly (search.css), so both documents list the Templates with this.
// SPDX-License-Identifier: GPL-3.0-or-later
import "./reader-options.js";

const rendered = new WeakMap();

// Lists `anki`'s Templates in `select` by name, so the list stays put as a
// choice moves its Template first, with `chosen` chosen: the first Template,
// or a choice still being saved. As in Yomitan's profile switch, the list's
// heading names it, and the switch is shown only with more than one.
export function renderTemplateChoices(select, anki, chosen = anki.templates[0].id) {
  const choices = anki.templates.map(({ id, name }) => [id, name])
    .sort(([leftId, left], [rightId, right]) => left.localeCompare(right) || leftId.localeCompare(rightId));
  const key = JSON.stringify(choices);
  // An unchanged list keeps its options, so an open menu stays open.
  if (rendered.get(select) !== key) {
    const document = select.ownerDocument;
    const group = document.createElement("optgroup");
    group.label = "Anki Template";
    group.append(...choices.map(([id, name]) => new document.defaultView.Option(name, id)));
    select.replaceChildren(group);
    rendered.set(select, key);
  }
  select.value = chosen;
  select.hidden = choices.length < 2;
}

// `anki` with the Template `id` first and the others in their order, as Set
// built-in leaves them; null when it has no such Template.
export function withBuiltinTemplate(anki, id) {
  const chosen = anki.templates.find(template => template.id === id);
  if (!chosen) return null;
  return globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
    templates: [chosen, ...anki.templates.filter(template => template !== chosen)] });
}
