const { ipcRenderer } = require('electron');

const FIND_IN_PAGE_COMMAND_CHANNEL = 'gsm-find-in-page:command';
const FIND_IN_PAGE_RESULT_CHANNEL = 'gsm-find-in-page:result';
const FIND_IN_PAGE_SHORTCUT_CHANNEL = 'gsm-find-in-page:shortcut';
const HOST_ID = 'gsm-find-in-page-host';
const SEARCH_DEBOUNCE_MS = 120;

let host = null;
let root = null;
let input = null;
let previousButton = null;
let nextButton = null;
let closeButton = null;
let matchCaseInput = null;
let status = null;
let visible = false;
let searchDebounceTimer = null;

function sendCommand(payload) {
  ipcRenderer.send(FIND_IN_PAGE_COMMAND_CHANNEL, payload);
}

function updateNavigationButtons() {
  const hasQuery = !!(input && input.value.trim());
  if (previousButton) {
    previousButton.disabled = !hasQuery;
  }
  if (nextButton) {
    nextButton.disabled = !hasQuery;
  }
}

function updateStatus(text, tone = 'idle') {
  if (!status) {
    return;
  }
  status.textContent = text;
  status.dataset.tone = tone;
}

function clearPendingSearch() {
  if (searchDebounceTimer !== null) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
}

function queueSearch() {
  clearPendingSearch();
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    runSearch({ forward: true, startNewSearch: true });
  }, SEARCH_DEBOUNCE_MS);
}

function runSearch({ forward, startNewSearch }) {
  if (!input) {
    return;
  }

  const text = input.value.trim();
  updateNavigationButtons();

  if (!text) {
    updateStatus('Type to search', 'idle');
    sendCommand({ action: 'clear' });
    return;
  }

  updateStatus('Searching...', 'pending');
  sendCommand({
    action: 'search',
    text,
    forward,
    startNewSearch,
    matchCase: !!(matchCaseInput && matchCaseInput.checked),
  });
}

function notifyVisibility(nextVisible) {
  visible = nextVisible;
  sendCommand({
    action: 'visibility',
    visible: nextVisible,
  });
}

function getActiveSelectionText() {
  const activeElement = document.activeElement;
  if (
    activeElement &&
    (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement
    )
  ) {
    const selectedText = activeElement.value.slice(
      activeElement.selectionStart || 0,
      activeElement.selectionEnd || 0,
    ).trim();
    if (selectedText) {
      return selectedText;
    }
  }

  const selectionText = String(window.getSelection ? window.getSelection() : '').trim();
  return selectionText;
}

function showFindBar() {
  ensureUi();
  if (!root || !input) {
    return;
  }

  if (!visible) {
    root.hidden = false;
    root.style.display = 'flex';
    notifyVisibility(true);
  }

  const selectionText = getActiveSelectionText();
  if (!input.value && selectionText) {
    input.value = selectionText;
    updateNavigationButtons();
  }

  if (input.value.trim()) {
    clearPendingSearch();
    runSearch({ forward: true, startNewSearch: true });
  }

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function hideFindBar() {
  clearPendingSearch();
  if (root) {
    root.hidden = true;
    root.style.display = 'none';
  }
  if (visible) {
    notifyVisibility(false);
  }
  updateStatus('Type to search', 'idle');
  sendCommand({ action: 'clear' });
}

function createButton(label, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  return button;
}

function ensureUi() {
  if (host && root) {
    return;
  }

  host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
  }

  Object.assign(host.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    zIndex: '2147483647',
    pointerEvents: 'none',
  });

  root = document.createElement('div');
  root.hidden = true;
  Object.assign(root.style, {
    display: 'none',
    alignItems: 'center',
    gap: '8px',
    minWidth: '320px',
    maxWidth: 'min(420px, calc(100vw - 32px))',
    padding: '10px 12px',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    borderRadius: '10px',
    background: 'rgba(28, 28, 32, 0.96)',
    color: '#f5f5f5',
    boxShadow: '0 10px 26px rgba(0, 0, 0, 0.34)',
    backdropFilter: 'blur(12px)',
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    pointerEvents: 'auto',
  });

  input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Find in page';
  Object.assign(input.style, {
    flex: '1 1 auto',
    minWidth: '120px',
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(255, 255, 255, 0.16)',
    outline: 'none',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#ffffff',
  });

  previousButton = createButton('Prev', 'Previous match');
  nextButton = createButton('Next', 'Next match');
  closeButton = createButton('Close', 'Close find bar');

  for (const button of [previousButton, nextButton, closeButton]) {
    Object.assign(button.style, {
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(255, 255, 255, 0.16)',
      background: 'rgba(255, 255, 255, 0.08)',
      color: '#ffffff',
      cursor: 'pointer',
    });
  }

  const matchCaseLabel = document.createElement('label');
  Object.assign(matchCaseLabel.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    whiteSpace: 'nowrap',
  });

  matchCaseInput = document.createElement('input');
  matchCaseInput.type = 'checkbox';
  matchCaseLabel.appendChild(matchCaseInput);
  matchCaseLabel.appendChild(document.createTextNode('Match case'));

  status = document.createElement('span');
  status.textContent = 'Type to search';
  status.dataset.tone = 'idle';
  Object.assign(status.style, {
    fontSize: '12px',
    color: '#c8c8c8',
    whiteSpace: 'nowrap',
  });

  input.addEventListener('input', () => {
    updateStatus(input.value.trim() ? 'Searching...' : 'Type to search', input.value.trim() ? 'pending' : 'idle');
    queueSearch();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearPendingSearch();
      runSearch({ forward: !event.shiftKey, startNewSearch: false });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideFindBar();
    }
  });

  previousButton.addEventListener('click', () => {
    clearPendingSearch();
    runSearch({ forward: false, startNewSearch: false });
  });

  nextButton.addEventListener('click', () => {
    clearPendingSearch();
    runSearch({ forward: true, startNewSearch: false });
  });

  closeButton.addEventListener('click', () => {
    hideFindBar();
  });

  matchCaseInput.addEventListener('change', () => {
    clearPendingSearch();
    runSearch({ forward: true, startNewSearch: true });
  });

  root.appendChild(input);
  root.appendChild(previousButton);
  root.appendChild(nextButton);
  root.appendChild(matchCaseLabel);
  root.appendChild(status);
  root.appendChild(closeButton);
  host.appendChild(root);
  updateNavigationButtons();
}

ipcRenderer.on(FIND_IN_PAGE_RESULT_CHANNEL, (_event, result = {}) => {
  if (result.cleared) {
    updateStatus('Type to search', 'idle');
    return;
  }

  if (!result.finalUpdate) {
    updateStatus('Searching...', 'pending');
    return;
  }

  if (!result.matches) {
    updateStatus('No matches', 'miss');
    return;
  }

  updateStatus(`${result.activeMatchOrdinal} / ${result.matches}`, 'match');
});

ipcRenderer.on(FIND_IN_PAGE_SHORTCUT_CHANNEL, (_event, payload = {}) => {
  if (payload.action === 'show') {
    showFindBar();
  } else if (payload.action === 'hide') {
    hideFindBar();
  }
});

window.addEventListener('DOMContentLoaded', () => {
  ensureUi();
});

window.addEventListener('beforeunload', () => {
  clearPendingSearch();
  if (visible) {
    notifyVisibility(false);
  }
});
