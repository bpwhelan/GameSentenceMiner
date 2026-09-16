/* Public GSM facade. Discover the supported API with capabilities(); see HACHIDORI_BRIDGE.md. */
(() => {
  class HachidoriOverlayBridge extends window.GsmExtensionBridge {
    constructor(options = {}) { super({ ...options, reader: 'hachidori' }); }
    ready() {
      if (!this._readiness) {
        this._readiness = (async () => {
          const deadline = Date.now() + 5000;
          while (!this._destroyed) {
            try {
              const capabilities = await super.invoke('capabilities', {}, { timeoutMs: 150 });
              if (capabilities.version !== 1) throw new Error(`Unsupported Hachidori bridge version: ${capabilities.version}`);
              return capabilities;
            } catch (error) {
              if (this._destroyed || Date.now() >= deadline || !error.message.includes('timed out')) throw error;
            }
          }
          throw new Error('Hachidori overlay bridge destroyed');
        })().catch(error => { this._readiness = null; throw error; });
      }
      return this._readiness;
    }
    async invoke(action, body = {}, options = {}) {
      // Queue startup requests behind one read-only handshake. Mutating requests are never retried.
      if (action !== 'capabilities') await this.ready();
      return super.invoke(action, body, options);
    }
    capabilities(options) { return this.invoke('capabilities', {}, options); }
    state(options) { return this.invoke('state', {}, options); }
    control(action, body = {}, options) { return this.invoke('control', { ...body, action }, options); }
    termEntries(text, options) { return this.invoke('terms', { text }, options); }
    kanjiEntries(character, options) { return this.invoke('kanji', { character }, options); }
    closePopups(options) { return this.control('hide-popup', {}, options); }
  }
  window.GsmHachidoriBridge = HachidoriOverlayBridge;
  window.gsmHachidoriBridge = new HachidoriOverlayBridge();
})();
