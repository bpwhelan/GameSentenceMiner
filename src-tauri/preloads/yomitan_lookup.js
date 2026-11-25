(async (text) => {
    async function request(action, params) {
        const response = await chrome.runtime.sendMessage({action, params});
        if (response?.error) throw new Error(response.error.message || String(response.error));
        if (!response || !Object.hasOwn(response, 'result')) throw new Error(`No Yomitan response to ${action}`);
        return response.result;
    }

    // The WebView2 navigation can finish before the extension worker and its
    // offscreen database are ready. Yomitan handles this message after setup.
    if (!globalThis.__gsmYomitanBackendReady) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Yomitan backend readiness timed out')), 15000);
        });
        globalThis.__gsmYomitanBackendReady = Promise.race([request('requestBackendReadySignal'), timeout])
            .catch(error => {
                delete globalThis.__gsmYomitanBackendReady;
                throw error;
            })
            .finally(() => clearTimeout(timer));
    }
    await globalThis.__gsmYomitanBackendReady;
    return request('termsFind', {text, details: {}, optionsContext: {current: true}});
})
