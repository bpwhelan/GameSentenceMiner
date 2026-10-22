(function () {
  let selected = [...GSMQuickActions.DEFAULT_ACTIONS];
  function render(value) {
    selected = GSMQuickActions.normalizeActions(value);
    const root = document.getElementById('quick-actions-choices');
    if (!root) return;
    root.replaceChildren();
    const ordered = [...selected, ...GSMQuickActions.ACTIONS.map(item => item.id).filter(id => !selected.includes(id))];
    ordered.forEach(id => {
      const action = GSMQuickActions.ACTIONS.find(item => item.id === id);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 0';
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:10px;flex:1;margin:0';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = selected.includes(id); checkbox.dataset.quickAction = id;
      checkbox.onchange = () => save(checkbox.checked ? [...selected, id] : selected.filter(item => item !== id));
      label.append(checkbox, document.createTextNode(action.label)); row.append(label);
      for (const [delta, title, glyph] of [[-1, 'Move up', '↑'], [1, 'Move down', '↓']]) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = glyph; button.className = 'guide-button';
        button.setAttribute('aria-label', `${title}: ${action.label}`); button.title = title;
        const index = selected.indexOf(id);
        button.disabled = index < 0 || index + delta < 0 || index + delta >= selected.length;
        button.onclick = () => {
          const next = [...selected]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; save(next);
        };
        row.append(button);
      }
      root.append(row);
    });
  }
  function save(value) { void commitSettingValue('gamepadQuickActions', value); }
  window.GSMQuickActionsSettings = { render };
}());
