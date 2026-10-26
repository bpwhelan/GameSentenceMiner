const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('../../node_modules/jsdom');

test('the invisible startup spinner has no running animation until shown', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  const dom = new JSDOM(`<style>${styles}</style><div id="loading-indicator"><div class="loading-spinner"></div></div>`);
  try {
    const { document } = dom.window;
    const spinner = document.querySelector('.loading-spinner');
    const indicator = document.getElementById('loading-indicator');
    assert.equal(dom.window.getComputedStyle(spinner).animation, 'none');
    indicator.classList.add('show');
    assert.match(dom.window.getComputedStyle(spinner).animation, /spin/);
    indicator.classList.remove('show');
    assert.equal(dom.window.getComputedStyle(spinner).animation, 'none');
  } finally { dom.window.close(); }
});
