/* GSM's Yomitan API facade; transport is shared with the other dictionary readers. */
(() => {
  class YomitanOverlayBridge extends window.GsmExtensionBridge {
    constructor(options = {}) { super({ ...options, reader: 'yomitan' }); }

    async yomitanVersion(options = {}) {
      return await this.invoke('yomitanVersion', {}, options);
    }

    async termEntries(term, options = {}) {
      return await this.invoke('termEntries', { term }, options);
    }

    async kanjiEntries(character, options = {}) {
      return await this.invoke('kanjiEntries', { character }, options);
    }

    async ankiFields(input, options = {}) {
      return await this.invoke('ankiFields', input || {}, options);
    }

    async tokenize(text, scanLength = 10, options = {}) {
      return await this.invoke('tokenize', { text, scanLength }, options);
    }

    async closePopups(options = {}) {
      return await this.invoke('closePopups', {}, options);
    }

    async ensureGsmCharacterDictionary(input = {}, options = {}) {
      return await this.invoke('ensureGsmCharacterDictionary', input || {}, options);
    }

  }
  window.GsmYomitanBridge = YomitanOverlayBridge;
  window.gsmYomitanBridge = new YomitanOverlayBridge();
  if (typeof module !== 'undefined' && module.exports) module.exports = { YomitanOverlayBridge };
})();
