(() => {
    "use strict";

    const ICE_SERVERS = [{
        urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
    }];

    const elements = {
        video: document.getElementById("remoteVideo"),
        quality: document.getElementById("qualitySelect"),
        audio: document.getElementById("audioButton"),
        audioStatus: document.getElementById("audioStatus"),
        stats: document.getElementById("streamStats"),
        stage: document.getElementById("videoStage"),
        overlay: document.getElementById("ocrOverlay"),
        empty: document.getElementById("emptyState"),
        notice: document.getElementById("streamNotice"),
        connectionDot: document.getElementById("connectionDot"),
        connectionLabel: document.getElementById("connectionLabel"),
        connect: document.getElementById("connectButton"),
        disconnect: document.getElementById("disconnectButton"),
        fullscreen: document.getElementById("fullscreenButton"),
        inputToggle: document.getElementById("inputToggle"),
        inputTitle: document.getElementById("inputTitle"),
        inputDescription: document.getElementById("inputDescription"),
        lookupDialog: document.getElementById("lookupDialog"),
        lookupHeading: document.getElementById("lookupHeading"),
        lookupContent: document.getElementById("lookupContent"),
        closeLookupDialog: document.getElementById("closeLookupDialog"),
    };

    const state = {
        socket: null,
        peer: null,
        inputAvailable: false,
        inputEnabled: false,
        overlayLines: [],
        pointerFrame: 0,
        pendingPointer: null,
        intentionalClose: false,
    };

    function setConnection(label, status = "idle") {
        elements.connectionLabel.textContent = label;
        elements.connectionDot.dataset.status = status;
    }

    function showNotice(message, isError = false) {
        elements.notice.textContent = message;
        elements.notice.classList.toggle("error", isError);
        elements.notice.hidden = false;
    }

    function clearNotice() {
        elements.notice.hidden = true;
        elements.notice.textContent = "";
    }

    function websocketUrl() {
        const url = new URL("/ws/remote-play", window.location.href);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }

    function send(message) {
        if (state.socket?.readyState !== WebSocket.OPEN) return false;
        state.socket.send(JSON.stringify(message));
        return true;
    }

    async function waitForIceGathering(peer) {
        if (peer.iceGatheringState === "complete") return;
        await new Promise((resolve) => {
            const handleState = () => {
                if (peer.iceGatheringState !== "complete") return;
                peer.removeEventListener("icegatheringstatechange", handleState);
                resolve();
            };
            peer.addEventListener("icegatheringstatechange", handleState);
            window.setTimeout(() => {
                peer.removeEventListener("icegatheringstatechange", handleState);
                resolve();
            }, 4000);
        });
    }

    async function startPeerConnection() {
        state.peer?.close();
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        state.peer = peer;
        elements.quality.disabled = true;
        elements.audio.disabled = true;
        elements.audioStatus.textContent = "Starting game audio…";
        const stream = new MediaStream();
        elements.video.srcObject = stream;
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.addTransceiver("audio", { direction: "recvonly" });
        peer.addEventListener("track", (event) => {
            if (state.peer !== peer) return;
            stream.addTrack(event.track);
            elements.video.play().catch(() => {
                elements.video.muted = true;
                elements.audio.textContent = "Enable sound";
                elements.video.play().catch(() => showNotice("Select Enable sound to start playback."));
            });
        });
        peer.addEventListener("connectionstatechange", () => {
            if (state.peer !== peer) return;
            const status = peer.connectionState;
            if (status === "connected") {
                setConnection("Live", "live");
                elements.empty.hidden = true;
                elements.inputToggle.disabled = !state.inputAvailable;
                if (state.inputAvailable) send({ type: "input_enabled", enabled: true });
                clearNotice();
            } else if (["failed", "disconnected", "closed"].includes(status)) {
                stopInput(`peer-${status}`);
                elements.inputToggle.disabled = true;
                setConnection(status === "failed" ? "Stream failed" : "Disconnected", "error");
                if (status === "failed") showNotice("The WebRTC stream failed. Reconnect to try again.", true);
            }
        });

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGathering(peer);
        send({ type: "offer", sdp: peer.localDescription.sdp, quality: elements.quality.value });
    }

    async function handleSocketMessage(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (_error) {
            return;
        }
        if (message.type === "ready") {
            state.inputAvailable = Boolean(message.input_available);
            elements.inputToggle.disabled = true;
            elements.disconnect.disabled = false;
            setConnection("Starting OBS", "connecting");
            await startPeerConnection();
            return;
        }
        if (message.type === "answer" && state.peer) {
            await state.peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
            return;
        }
        if (message.type === "stream_state") {
            if (message.state === "connecting") setConnection("Opening camera", "connecting");
            return;
        }
        if (message.type === "audio_state") {
            elements.audio.disabled = !message.available;
            elements.audioStatus.textContent = message.available ? "Game audio" : (message.message || "Game audio unavailable");
            elements.audio.textContent = elements.video.muted ? "Enable sound" : "Mute";
            return;
        }
        if (message.type === "input_state") {
            applyInputState(Boolean(message.enabled));
            if (!message.accepted) {
                showNotice("Bring the configured game window to the foreground, then enable input again.", true);
            }
            return;
        }
        if (message.type === "overlay") {
            updateOverlay(message.payload);
            return;
        }
        if (message.type === "error") {
            disconnect();
            elements.inputToggle.disabled = true;
            showNotice(message.message || "Remote play reported an error.", true);
            setConnection("Unavailable", "error");
        }
    }

    async function connect() {
        if (state.socket && state.socket.readyState < WebSocket.CLOSING) return;
        clearNotice();
        setConnection("Connecting", "connecting");
        elements.connect.disabled = true;
        state.intentionalClose = false;
        try {
            const socket = new WebSocket(websocketUrl());
            state.socket = socket;
            socket.addEventListener("message", (event) => {
                handleSocketMessage(event).catch((error) => {
                    showNotice(error.message || "Could not negotiate the stream.", true);
                });
            });
            socket.addEventListener("close", (event) => {
                if (state.socket !== socket) return;
                state.socket = null;
                stopInput("disconnect", false);
                state.peer?.close();
                state.peer = null;
                elements.video.srcObject = null;
                resetMediaControls();
                elements.empty.hidden = false;
                elements.disconnect.disabled = true;
                elements.inputToggle.disabled = true;
                elements.connect.disabled = false;
                if (!state.intentionalClose) {
                    const busy = event.code === 1013;
                    setConnection(busy ? "Session in use" : "Disconnected", busy ? "error" : "idle");
                    showNotice(busy ? "Another browser is already connected." : "The remote session ended.", busy);
                }
            });
            socket.addEventListener("error", () => showNotice("Could not reach GSM's signaling server.", true));
        } catch (error) {
            setConnection("Unavailable", "error");
            showNotice(error.message || "Could not connect.", true);
        } finally {
            elements.connect.disabled = false;
        }
    }

    function disconnect() {
        state.intentionalClose = true;
        stopInput("disconnect");
        state.peer?.close();
        state.peer = null;
        state.socket?.close(1000, "Client disconnected");
        state.socket = null;
        elements.video.srcObject = null;
        resetMediaControls();
        elements.empty.hidden = false;
        elements.disconnect.disabled = true;
        elements.inputToggle.disabled = true;
        setConnection("Disconnected", "idle");
    }

    function resetMediaControls() {
        elements.quality.disabled = false;
        elements.audio.disabled = true;
        elements.audioStatus.textContent = "Game audio disconnected";
        elements.stats.textContent = "";
    }

    elements.audio.addEventListener("click", async () => {
        elements.video.muted = !elements.video.muted;
        try {
            await elements.video.play();
            elements.audio.textContent = elements.video.muted ? "Enable sound" : "Mute";
        } catch (_error) {
            elements.video.muted = true;
            elements.audio.textContent = "Enable sound";
            showNotice("Playback was blocked. Select Enable sound to try again.", true);
        }
    });

    let previousVideoStats = null;
    let statsBusy = false;
    window.setInterval(async () => {
        const peer = state.peer;
        if (!peer || peer.connectionState !== "connected") {
            previousVideoStats = null;
            return;
        }
        if (statsBusy) return;
        statsBusy = true;
        try {
            const stats = await peer.getStats();
            if (state.peer !== peer) return;
            stats.forEach((report) => {
                if (report.type !== "inbound-rtp" || report.kind !== "video") return;
                const previous = previousVideoStats;
                const elapsed = previous?.peer === peer ? report.timestamp - previous.timestamp : 0;
                const mbps = elapsed > 0 ? (report.bytesReceived - previous.bytesReceived) * 8 / elapsed / 1000 : 0;
                elements.stats.textContent = [
                    `${report.frameWidth || elements.video.videoWidth} × ${report.frameHeight || elements.video.videoHeight}`,
                    `${Math.round(report.framesPerSecond || 0)} fps`,
                    elapsed > 0 ? `${mbps.toFixed(1)} Mbps` : "Measuring…",
                ].join(" · ");
                previousVideoStats = { peer, timestamp: report.timestamp, bytesReceived: report.bytesReceived };
            });
        } catch (_error) {
            // A peer may close while its statistics request is pending.
        } finally {
            statsBusy = false;
        }
    }, 1000);

    function applyInputState(enabled) {
        state.inputEnabled = enabled;
        elements.inputToggle.checked = enabled;
        elements.inputTitle.textContent = enabled ? "Remote input is active" : "Remote input is off";
        elements.inputDescription.textContent = enabled
            ? "Control the game or click text to look it up. Press Escape to stop input."
            : "Video and OCR lookup are available without controlling the game.";
        if (enabled) elements.stage.focus({ preventScroll: true });
    }

    function stopInput(reason, notifyServer = true) {
        if (notifyServer && state.socket?.readyState === WebSocket.OPEN) {
            send({ type: "stop_input", reason });
        }
        applyInputState(false);
    }

    function containedVideoRect() {
        const stage = elements.stage.getBoundingClientRect();
        const sourceWidth = elements.video.videoWidth || 16;
        const sourceHeight = elements.video.videoHeight || 9;
        const scale = Math.min(stage.width / sourceWidth, stage.height / sourceHeight);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        return {
            stage,
            left: (stage.width - width) / 2,
            top: (stage.height - height) / 2,
            width,
            height,
        };
    }

    function normalizedPointer(event) {
        const videoRect = containedVideoRect();
        const localX = event.clientX - videoRect.stage.left - videoRect.left;
        const localY = event.clientY - videoRect.stage.top - videoRect.top;
        return {
            x: Math.max(0, Math.min(1, localX / videoRect.width)),
            y: Math.max(0, Math.min(1, localY / videoRect.height)),
            inside: localX >= 0 && localY >= 0 && localX <= videoRect.width && localY <= videoRect.height,
        };
    }

    function queuePointerMove(event) {
        if (!state.inputEnabled || isLookupEvent(event)) return;
        state.pendingPointer = normalizedPointer(event);
        if (state.pointerFrame) return;
        state.pointerFrame = window.requestAnimationFrame(() => {
            state.pointerFrame = 0;
            if (state.inputEnabled && state.pendingPointer?.inside) {
                send({ type: "pointer_move", x: state.pendingPointer.x, y: state.pendingPointer.y });
            }
        });
    }

    function pointerButtonName(button) {
        return ["left", "middle", "right"][button] || "left";
    }

    function isLookupEvent(event) {
        return event.target instanceof Element && Boolean(event.target.closest(".ocr-region, dialog"));
    }

    function updateOverlay(payload) {
        if (!payload || typeof payload !== "object") return;
        if (payload.type === "overlay_clear") {
            state.overlayLines = [];
        } else if (payload.type === "word_coordinates" && Array.isArray(payload.data)) {
            state.overlayLines = payload.supplemental ? [...state.overlayLines, ...payload.data] : payload.data;
        } else {
            return;
        }
        renderOverlay();
    }

    function rectangleBounds(rectangle) {
        const xValues = [rectangle.x1, rectangle.x2, rectangle.x3, rectangle.x4].map(Number);
        const yValues = [rectangle.y1, rectangle.y2, rectangle.y3, rectangle.y4].map(Number);
        if (![...xValues, ...yValues].every(Number.isFinite)) return null;
        const left = Math.max(0, Math.min(1, Math.min(...xValues)));
        const top = Math.max(0, Math.min(1, Math.min(...yValues)));
        const right = Math.max(0, Math.min(1, Math.max(...xValues)));
        const bottom = Math.max(0, Math.min(1, Math.max(...yValues)));
        return { left, top, width: right - left, height: bottom - top };
    }

    function renderOverlay() {
        elements.overlay.replaceChildren();
        const videoRect = containedVideoRect();
        for (const line of state.overlayLines) {
            const regions = Array.isArray(line.words) && line.words.length ? line.words : [line];
            for (const region of regions) {
                const bounds = rectangleBounds(region.bounding_rect || line.bounding_rect || {});
                const text = String(region.text || line.text || "").trim();
                if (!bounds || !text || bounds.width <= 0 || bounds.height <= 0) continue;
                const button = document.createElement("button");
                button.type = "button";
                button.className = "ocr-region";
                button.textContent = text;
                button.title = `Look up ${text}`;
                button.style.left = `${videoRect.left + bounds.left * videoRect.width}px`;
                button.style.top = `${videoRect.top + bounds.top * videoRect.height}px`;
                button.style.width = `${Math.max(6, bounds.width * videoRect.width)}px`;
                button.style.height = `${Math.max(6, bounds.height * videoRect.height)}px`;
                button.addEventListener("click", (event) => {
                    event.stopPropagation();
                    lookupText(text);
                });
                elements.overlay.appendChild(button);
            }
        }
    }

    function selectTokenGroups(payload) {
        if (!Array.isArray(payload)) return [];
        const indexed = payload.filter((entry) => Number(entry?.index) === 0 && Array.isArray(entry.content));
        const candidates = indexed.length ? indexed : payload.filter((entry) => Array.isArray(entry?.content));
        return candidates.reduce((best, entry) => entry.content.length > best.length ? entry.content : best, []);
    }

    async function lookupText(text) {
        elements.lookupHeading.textContent = text;
        elements.lookupContent.replaceChildren(document.createTextNode("Looking up…"));
        elements.lookupDialog.showModal();
        try {
            const response = await fetch("/api/remote-play/lookup", {
                method: "POST",
                cache: "no-store",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text, scan_length: 20 }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || "Lookup failed.");
            const groups = selectTokenGroups(payload);
            elements.lookupContent.replaceChildren();
            if (!groups.length) {
                elements.lookupContent.textContent = "No Yomitan tokenization result was returned.";
                return;
            }
            for (const group of groups) {
                if (!Array.isArray(group)) continue;
                const row = document.createElement("div");
                row.className = "lookup-row";
                const surface = group.map((segment) => String(segment?.text || "")).join("");
                const reading = group.map((segment) => String(segment?.reading || "")).join("").trim();
                const term = document.createElement("strong");
                term.textContent = surface;
                row.appendChild(term);
                if (reading && reading !== surface) {
                    const readingNode = document.createElement("span");
                    readingNode.textContent = reading;
                    row.appendChild(readingNode);
                }
                elements.lookupContent.appendChild(row);
            }
        } catch (error) {
            elements.lookupContent.textContent = error.message || "Lookup failed.";
        }
    }

    elements.connect.addEventListener("click", () => connect());
    elements.disconnect.addEventListener("click", disconnect);
    elements.closeLookupDialog.addEventListener("click", () => elements.lookupDialog.close());
    elements.fullscreen.addEventListener("click", () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else elements.stage.requestFullscreen();
    });
    elements.inputToggle.addEventListener("change", () => {
        send({ type: "input_enabled", enabled: elements.inputToggle.checked });
        if (!elements.inputToggle.checked) applyInputState(false);
    });
    elements.stage.addEventListener("pointermove", queuePointerMove);
    elements.stage.addEventListener("pointerdown", (event) => {
        if (!state.inputEnabled || isLookupEvent(event)) return;
        const pointer = normalizedPointer(event);
        if (!pointer.inside) return;
        event.preventDefault();
        elements.stage.focus({ preventScroll: true });
        elements.stage.setPointerCapture(event.pointerId);
        send({ type: "pointer_move", x: pointer.x, y: pointer.y });
        send({ type: "pointer_button", button: pointerButtonName(event.button), pressed: true });
    });
    elements.stage.addEventListener("pointerup", (event) => {
        if (!state.inputEnabled || isLookupEvent(event)) return;
        event.preventDefault();
        send({ type: "pointer_button", button: pointerButtonName(event.button), pressed: false });
    });
    elements.stage.addEventListener("pointercancel", () => stopInput("pointercancel"));
    elements.stage.addEventListener("contextmenu", (event) => {
        if (state.inputEnabled) event.preventDefault();
    });
    elements.stage.addEventListener("wheel", (event) => {
        if (!state.inputEnabled || isLookupEvent(event)) return;
        event.preventDefault();
        send({ type: "wheel", delta_x: event.deltaX, delta_y: event.deltaY });
    }, { passive: false });
    window.addEventListener("keydown", (event) => {
        if (!state.inputEnabled || (event.target instanceof Element && event.target.closest("dialog, input, button"))) return;
        event.preventDefault();
        send({ type: "key_down", code: event.code, repeat: event.repeat });
        if (event.code === "Escape") stopInput("escape", false);
    });
    window.addEventListener("keyup", (event) => {
        if (!state.inputEnabled || (event.target instanceof Element && event.target.closest("dialog, input, button"))) return;
        event.preventDefault();
        send({ type: "key_up", code: event.code });
    });
    window.addEventListener("blur", () => stopInput("blur"));
    window.addEventListener("resize", renderOverlay);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopInput("visibility-hidden");
    });
    window.addEventListener("pagehide", () => {
        stopInput("pagehide");
        state.peer?.close();
        state.socket?.close();
    });

    setConnection("Disconnected", "idle");
    applyInputState(false);
})();
