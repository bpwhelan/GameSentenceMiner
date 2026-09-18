// SPDX-License-Identifier: LGPL-3.0-only
const { contextBridge, ipcRenderer } = require('electron');
const HACHIDORI_SPEECH_SYNTHESIS_CHANNEL = 'hachidori-speech-synthesize';

contextBridge.exposeInMainWorld('gsmHachidoriSpeech', Object.freeze({
  synthesize(request) {
    return ipcRenderer.invoke(HACHIDORI_SPEECH_SYNTHESIS_CHANNEL, request);
  },
}));
