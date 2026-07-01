/******/ (() => { // webpackBootstrap
let currentAudio;
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'playTtsAudio') {
        return false;
    }
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = undefined;
    }
    if (!message.data?.length) {
        sendResponse({ ok: false, error: 'No audio data' });
        return false;
    }
    const blob = new Blob([new Uint8Array(message.data)]);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.addEventListener('ended', () => {
        URL.revokeObjectURL(url);
        currentAudio = undefined;
    }, { once: true });
    audio
        .play()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
});
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'stopTtsAudio' && currentAudio) {
        currentAudio.pause();
        currentAudio = undefined;
    }
});

/******/ })()
;