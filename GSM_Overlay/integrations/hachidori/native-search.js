// Native webviews cannot execute code across a sandboxed frame boundary.
// Keep that boundary and accept a bounded search request from the owning shell.
const requests = new Set();
globalThis.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.type !== 'gsm.native-search') return;
  const { id, text, offset } = event.data;
  if (typeof id !== 'string' || typeof text !== 'string' || text.length > 100000 || !Number.isInteger(offset) || offset < 0 || offset > text.length) return;
  if (requests.has(id)) return;
  requests.add(id); if (requests.size > 100) requests.delete(requests.values().next().value);
  const reply = error => parent.postMessage({ type: 'gsm.native-search.result', id, error }, '*');
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const input = document.querySelector('input[type="text"], input[type="search"], textarea');
      const submit = document.querySelector('button[type="submit"]');
      if (input && submit && !submit.disabled) {
        input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); submit.click();
        const query = document.getElementById('search-query');
        while (!query?.firstChild && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        if (!query?.firstChild) throw Error('Dictionary search did not become ready.');
        await globalThis.HDSearchHistory?.lookUp(query.firstChild, offset); reply(null); return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Dictionary search did not become ready.');
  } catch (error) { reply(String(error?.message || error)); }
});
