const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const path = require("node:path");

test("audio and video share one stream; autoplay fallback and reconnect controls work", async () => {
    class Surface {
        constructor() {
            this.listeners = {};
            this.classList = { toggle() {} };
            this.dataset = {};
            this.value = "high";
            this.muted = false;
        }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        emit(name, event = {}) { return this.listeners[name]?.(event); }
        replaceChildren() {}
        focus() {}
        closest() { return this.lookupRegion ? this : null; }
        getBoundingClientRect() { return { left: 0, top: 0, width: 160, height: 90 }; }
        setPointerCapture() {}
    }
    const elements = new Map();
    const document = new Surface();
    document.getElementById = (id) => {
        if (!elements.has(id)) elements.set(id, new Surface());
        return elements.get(id);
    };
    let peer, socket;
    class Peer extends Surface {
        constructor() { super(); peer = this; this.transceivers = []; this.iceGatheringState = "complete"; }
        addTransceiver(kind) { this.transceivers.push(kind); }
        async createOffer() { return { sdp: "offer", type: "offer" }; }
        async setLocalDescription(offer) { this.localDescription = offer; }
        close() { this.connectionState = "closed"; }
    }
    class Socket extends Surface {
        static OPEN = 1;
        static CLOSING = 2;
        constructor() { super(); socket = this; this.readyState = 1; this.sent = []; }
        send(message) { this.sent.push(JSON.parse(message)); }
        close() { this.readyState = 3; }
    }
    const window = new Surface();
    window.location = { href: "http://localhost:7275/remote-play", protocol: "http:" };
    window.setInterval = () => {};
    window.setTimeout = () => {};
    const context = {
        document, window, URL, Element: Surface, WebSocket: Socket, RTCPeerConnection: Peer,
        MediaStream: class { constructor() { this.tracks = []; } addTrack(track) { this.tracks.push(track); } },
        fetch: async () => { throw new Error("Connecting must not request a pairing code"); },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../GameSentenceMiner/web/static/js/remote-play.js"), "utf8"), context);
    const video = elements.get("remoteVideo");
    let playbackAttempts = 0;
    video.play = async () => { if (++playbackAttempts === 1) throw new Error("NotAllowedError"); };
    await elements.get("connectButton").emit("click");
    socket.emit("message", { data: JSON.stringify({ type: "ready", input_available: true }) });
    await new Promise(setImmediate);
    assert.deepEqual(peer.transceivers, ["video", "audio"]);
    assert.equal(socket.sent.at(-1).quality, "high");
    peer.connectionState = "connected";
    peer.emit("connectionstatechange");
    assert.deepEqual(socket.sent.at(-1), { type: "input_enabled", enabled: true });
    socket.emit("message", { data: JSON.stringify({ type: "input_state", enabled: true, accepted: true }) });
    assert.equal(elements.get("inputToggle").checked, true);
    const stage = elements.get("videoStage");
    const lookupRegion = new Surface();
    lookupRegion.lookupRegion = true;
    const pointer = { target: lookupRegion, clientX: 80, clientY: 45, button: 0, pointerId: 1,
        preventDefault() { throw new Error("Lookup gestures must keep their browser behavior"); } };
    const beforeLookup = socket.sent.length;
    for (const name of ["pointerdown", "pointerup", "pointermove", "wheel"]) stage.emit(name, pointer);
    assert.equal(socket.sent.length, beforeLookup, "Lookup gestures must not reach the game");
    const gamePointer = { ...pointer, target: stage, preventDefault() {} };
    stage.emit("pointerdown", gamePointer);
    stage.emit("pointerup", gamePointer);
    assert.deepEqual(socket.sent.slice(-3), [
        { type: "pointer_move", x: 0.5, y: 0.5 },
        { type: "pointer_button", button: "left", pressed: true },
        { type: "pointer_button", button: "left", pressed: false },
    ]);
    peer.emit("track", { track: { kind: "video" }, streams: [] });
    await new Promise(setImmediate);
    peer.emit("track", { track: { kind: "audio" }, streams: [] });
    socket.emit("message", { data: JSON.stringify({ type: "audio_state", available: true }) });
    assert.equal(video.srcObject.tracks.length, 2);
    assert.equal(video.muted, true);
    assert.equal(elements.get("audioButton").textContent, "Enable sound");
    await elements.get("audioButton").emit("click");
    assert.equal(video.muted, false);
    assert.equal(elements.get("audioButton").textContent, "Mute");
    elements.get("disconnectButton").emit("click");
    assert.equal(video.srcObject, null);
    assert.equal(elements.get("audioButton").disabled, true);
    assert.equal(elements.get("qualitySelect").disabled, false);
    // Delayed events from a closed peer must not replace the next stream.
    peer.emit("track", { track: { kind: "video" }, streams: [] });
    assert.equal(video.srcObject, null);
});
