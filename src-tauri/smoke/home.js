(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let shown = false;
  const blocked = [];
  document.addEventListener('securitypolicyviolation', event => blocked.push(`${event.violatedDirective}: ${event.blockedURI}`));
  window.addEventListener('yomitan-popup-shown', () => { shown = true; });
  window.addEventListener('yomitan-popup-hidden', () => { shown = false; });
  window.addEventListener('hachidori-popup-shown', () => { shown = true; });
  window.addEventListener('hachidori-popup-hidden', () => { shown = false; });
  const visible = reader => {
    if (shown || reader === 'hachidori') return shown;
    const popup = document.querySelector('iframe.yomitan-popup');
    return !!popup && popup.getBoundingClientRect().width > 0 && getComputedStyle(popup).visibility !== 'hidden';
  };
  for (let i = 0; i < 100 && !document.querySelector('.reading-text'); i++) await wait(100);
  const text = document.querySelector('.reading-text');
  if (text?.textContent !== '食べる' || text.dataset.gsmReaderScan !== 'shift') throw Error('Home transcript/Shift marker missing');
  text.scrollIntoView({block: 'center'});
  const move = (element, shiftKey) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 1);
    const rect = range.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (document.elementFromPoint(x, y) !== element) throw Error(`Cannot hover ${element.outerHTML.slice(0, 120)}`);
    const data = {bubbles: true, clientX: x, clientY: y, buttons: 0, shiftKey};
    element.dispatchEvent(new PointerEvent('pointermove', {...data, pointerType: 'mouse', isPrimary: true}));
    element.dispatchEvent(new MouseEvent('mousemove', data));
  };
  const assertBlocked = async (parent, reader) => {
    const word = document.createElement('span');
    word.textContent = text.textContent;
    parent.prepend(word);
    try {
      for (const shift of [false, true]) {
        move(word, shift);
        await wait(500);
        if (visible(reader)) throw Error(`${reader}: unexpected lookup outside feed text`);
      }
    } finally { word.remove(); }
  };
  window.__gsmSmokeHome = {
    async lookup(reader) {
      await assertBlocked(document.querySelector('.reading-line-meta'), reader);
      for (let i = 0; i < 10; i++) { move(text, false); await wait(100); }
      if (visible(reader)) throw Error(`${reader}: Home opened a popup without Shift`);
      // Shift must work even if the pointer is already over the word.
      for (let i = 0; i < 100; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Shift', code: 'ShiftLeft', shiftKey: true, bubbles: true}));
        await wait(100);
        if (visible(reader)) {
          document.dispatchEvent(new KeyboardEvent('keyup', {key: 'Shift', code: 'ShiftLeft', bubbles: true}));
          const home = document.querySelector('.tab-button.active');
          document.querySelector('.tab-button:not(.active)').click();
          for (let j = 0; j < 30 && (visible(reader) || text.isConnected); j++) await wait(100);
          if (visible(reader) || text.isConnected) throw Error(`${reader}: Home lookup persisted after leaving the tab`);
          await assertBlocked(document.querySelector('.tab-panel.active'), reader);
          home.click();
          return true;
        }
      }
      move(text, true);
      await wait(1500);
      throw Error(`${reader}: No Home dictionary popup on stationary Shift (moving=${visible(reader)}, blocked=${JSON.stringify(blocked)}, active=${document.activeElement?.outerHTML.slice(0, 200)}, tail=${Array.from(document.body.children).slice(-4).map(node => node.outerHTML.slice(0, 160)).join(';')})`);
    },
  };
  return true;
})()
