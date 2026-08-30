(() => {
    "use strict";

    const canvas = document.getElementById("areaCanvas");
    const context = canvas.getContext("2d");
    const canvasScroller = document.getElementById("canvasScroller");
    const configSelect = document.getElementById("configSelect");
    const sceneName = document.getElementById("sceneName");
    const areaList = document.getElementById("areaList");
    const emptyAreas = document.getElementById("emptyAreas");
    const areaCount = document.getElementById("areaCount");
    const sourceDimensions = document.getElementById("sourceDimensions");
    const dirtyIndicator = document.getElementById("dirtyIndicator");
    const overlayNotice = document.getElementById("overlayNotice");
    const canvasLoading = document.getElementById("canvasLoading");
    const imageInput = document.getElementById("imageInput");
    const toast = document.getElementById("statusToast");

    const modeInfo = {
        normal: { label: "Normal", color: "#4ad66d", fill: "rgba(74, 214, 109, 0.18)" },
        exclusion: { label: "Exclusion", color: "#ff9f43", fill: "rgba(255, 159, 67, 0.2)" },
        secondary: { label: "Secondary", color: "#b477ff", fill: "rgba(180, 119, 255, 0.19)" },
        exclusive: { label: "Exclusive", color: "#35c5f0", fill: "rgba(53, 197, 240, 0.19)" },
        black_hole: { label: "Black hole", color: "#f0f3f7", fill: "rgba(0, 0, 0, 0.68)" },
    };

    const state = {
        configName: "",
        scene: "",
        isOverlay: false,
        mode: "normal",
        rectangles: [],
        selectedIndex: -1,
        image: null,
        imageWidth: 1920,
        imageHeight: 1080,
        undoStack: [],
        redoStack: [],
        interaction: null,
        draft: null,
        dirty: false,
    };

    let toastTimer = null;

    function cloneRectangles(rectangles = state.rectangles) {
        return JSON.parse(JSON.stringify(rectangles));
    }

    function clamp(value, minimum = 0, maximum = 1) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    function rectangleMode(rectangle) {
        if (rectangle.is_black_hole) return "black_hole";
        if (rectangle.is_exclusive) return "exclusive";
        if (rectangle.is_secondary) return "secondary";
        if (rectangle.is_excluded) return "exclusion";
        return "normal";
    }

    function flagsForMode(mode) {
        return {
            is_excluded: mode === "exclusion",
            is_secondary: mode === "secondary",
            is_exclusive: mode === "exclusive",
            is_black_hole: mode === "black_hole",
        };
    }

    function createRectangle(coordinates, mode = state.mode) {
        return {
            monitor: { index: 0 },
            coordinates,
            ...flagsForMode(mode),
        };
    }

    function showStatus(message, error = false) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.toggle("error", error);
        toast.hidden = false;
        toastTimer = window.setTimeout(() => {
            toast.hidden = true;
        }, error ? 6000 : 3200);
    }

    async function responseJson(response) {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || `Request failed (${response.status}).`);
        }
        return payload;
    }

    function setDirty(dirty) {
        state.dirty = dirty;
        dirtyIndicator.hidden = !dirty;
        document.title = `${dirty ? "• " : ""}OCR Area Selector · GameSentenceMiner`;
    }

    function setMode(mode) {
        if (state.isOverlay && !["normal", "exclusion"].includes(mode)) {
            mode = "normal";
        }
        state.mode = mode;
        document.querySelectorAll(".mode-button").forEach((button) => {
            button.classList.toggle("active", button.dataset.mode === mode);
        });
    }

    function updateModeAvailability() {
        document.querySelectorAll(".mode-button").forEach((button) => {
            button.disabled = state.isOverlay && !["normal", "exclusion"].includes(button.dataset.mode);
        });
        overlayNotice.hidden = !state.isOverlay;
        setMode(state.mode);
    }

    function commitHistory(previousRectangles) {
        if (JSON.stringify(previousRectangles) === JSON.stringify(state.rectangles)) return;
        state.undoStack.push(previousRectangles);
        if (state.undoStack.length > 100) state.undoStack.shift();
        state.redoStack = [];
        setDirty(true);
        renderAll();
    }

    function undo() {
        if (!state.undoStack.length) return;
        state.redoStack.push(cloneRectangles());
        state.rectangles = state.undoStack.pop();
        state.selectedIndex = -1;
        setDirty(true);
        renderAll();
    }

    function redo() {
        if (!state.redoStack.length) return;
        state.undoStack.push(cloneRectangles());
        state.rectangles = state.redoStack.pop();
        state.selectedIndex = -1;
        setDirty(true);
        renderAll();
    }

    function deleteRectangle(index = state.selectedIndex) {
        if (index < 0 || index >= state.rectangles.length) return;
        const previous = cloneRectangles();
        state.rectangles.splice(index, 1);
        state.selectedIndex = Math.min(index, state.rectangles.length - 1);
        commitHistory(previous);
    }

    function resizeCanvas() {
        const aspect = Math.max(0.1, state.imageWidth / Math.max(1, state.imageHeight));
        const availableWidth = Math.max(280, canvasScroller.clientWidth - 44);
        const cssWidth = Math.min(1600, availableWidth);
        const cssHeight = Math.max(180, Math.round(cssWidth / aspect));
        const pixelRatio = Math.min(2, window.devicePixelRatio || 1);

        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.width = Math.round(cssWidth * pixelRatio);
        canvas.height = Math.round(cssHeight * pixelRatio);
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        renderCanvas();
    }

    function canvasSize() {
        return { width: canvas.clientWidth, height: canvas.clientHeight };
    }

    function drawEmptyBackground(width, height) {
        context.fillStyle = "#0b1017";
        context.fillRect(0, 0, width, height);
        const grid = 28;
        context.strokeStyle = "rgba(129, 151, 177, 0.1)";
        context.lineWidth = 1;
        for (let x = 0; x <= width; x += grid) {
            context.beginPath();
            context.moveTo(x + 0.5, 0);
            context.lineTo(x + 0.5, height);
            context.stroke();
        }
        for (let y = 0; y <= height; y += grid) {
            context.beginPath();
            context.moveTo(0, y + 0.5);
            context.lineTo(width, y + 0.5);
            context.stroke();
        }
        context.fillStyle = "#8090a4";
        context.font = "600 14px system-ui, sans-serif";
        context.textAlign = "center";
        context.fillText("Capture an OBS frame or open an image for reference", width / 2, height / 2);
    }

    function drawRectangle(rectangle, index, selected, width, height, dashed = false) {
        const [x, y, rectWidth, rectHeight] = rectangle.coordinates;
        const left = x * width;
        const top = y * height;
        const pixelWidth = rectWidth * width;
        const pixelHeight = rectHeight * height;
        const visual = modeInfo[rectangleMode(rectangle)];

        context.save();
        context.fillStyle = visual.fill;
        context.fillRect(left, top, pixelWidth, pixelHeight);
        context.strokeStyle = visual.color;
        context.lineWidth = selected ? 3 : 2;
        context.setLineDash(dashed ? [8, 5] : []);
        context.strokeRect(left + 1, top + 1, Math.max(0, pixelWidth - 2), Math.max(0, pixelHeight - 2));

        if (!dashed) {
            const label = `${index + 1} · ${visual.label}`;
            context.font = "700 12px system-ui, sans-serif";
            const labelWidth = context.measureText(label).width + 14;
            context.fillStyle = visual.color;
            context.fillRect(left, top, labelWidth, 24);
            context.fillStyle = rectangleMode(rectangle) === "black_hole" ? "#11151a" : "#07100d";
            context.textAlign = "left";
            context.textBaseline = "middle";
            context.fillText(label, left + 7, top + 12);
        }

        if (selected && !dashed) {
            context.setLineDash([]);
            [[left, top], [left + pixelWidth, top], [left + pixelWidth, top + pixelHeight], [left, top + pixelHeight]].forEach(
                ([handleX, handleY]) => {
                    context.fillStyle = "#ffffff";
                    context.fillRect(handleX - 5, handleY - 5, 10, 10);
                    context.strokeStyle = "#0b1118";
                    context.lineWidth = 2;
                    context.strokeRect(handleX - 5, handleY - 5, 10, 10);
                },
            );
        }
        context.restore();
    }

    function renderCanvas() {
        const { width, height } = canvasSize();
        if (!width || !height) return;
        context.clearRect(0, 0, width, height);
        if (state.image) {
            context.drawImage(state.image, 0, 0, width, height);
        } else {
            drawEmptyBackground(width, height);
        }

        state.rectangles.forEach((rectangle, index) => {
            drawRectangle(rectangle, index, index === state.selectedIndex, width, height);
        });
        if (state.draft) {
            drawRectangle(state.draft, state.rectangles.length, false, width, height, true);
        }
    }

    function formatCoordinates(coordinates) {
        const [x, y, width, height] = coordinates.map((value) => (value * 100).toFixed(1));
        return `x ${x}% · y ${y}% · w ${width}% · h ${height}%`;
    }

    function renderAreaList() {
        areaList.replaceChildren();
        state.rectangles.forEach((rectangle, index) => {
            const mode = rectangleMode(rectangle);
            const visual = modeInfo[mode];
            const item = document.createElement("li");
            item.className = `area-item${index === state.selectedIndex ? " selected" : ""}`;
            item.tabIndex = 0;
            item.dataset.index = String(index);

            const swatch = document.createElement("span");
            swatch.className = "area-swatch";
            swatch.style.background = visual.color;

            const description = document.createElement("div");
            description.className = "area-description";
            const title = document.createElement("strong");
            title.textContent = `${index + 1}. ${visual.label}`;
            const coordinates = document.createElement("span");
            coordinates.textContent = formatCoordinates(rectangle.coordinates);
            description.append(title, coordinates);

            const deleteButton = document.createElement("button");
            deleteButton.className = "area-delete";
            deleteButton.type = "button";
            deleteButton.title = `Delete area ${index + 1}`;
            deleteButton.setAttribute("aria-label", `Delete area ${index + 1}`);
            deleteButton.textContent = "×";
            deleteButton.addEventListener("click", (event) => {
                event.stopPropagation();
                deleteRectangle(index);
            });

            const select = () => {
                state.selectedIndex = index;
                renderAll();
                canvas.focus();
            };
            item.addEventListener("click", select);
            item.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select();
                }
            });
            item.append(swatch, description, deleteButton);
            areaList.append(item);
        });
        emptyAreas.hidden = state.rectangles.length > 0;
        areaCount.textContent = `${state.rectangles.length} ${state.rectangles.length === 1 ? "area" : "areas"}`;
    }

    function renderControls() {
        document.getElementById("undoButton").disabled = state.undoStack.length === 0;
        document.getElementById("redoButton").disabled = state.redoStack.length === 0;
        document.getElementById("deleteButton").disabled = state.selectedIndex < 0;
        document.getElementById("clearButton").disabled = state.rectangles.length === 0;
        document.getElementById("saveButton").disabled = !state.configName;
        sourceDimensions.textContent = `${state.imageWidth} × ${state.imageHeight}`;
    }

    function renderAll() {
        renderCanvas();
        renderAreaList();
        renderControls();
    }

    function normalizedPointer(event) {
        const bounds = canvas.getBoundingClientRect();
        return {
            x: clamp((event.clientX - bounds.left) / bounds.width),
            y: clamp((event.clientY - bounds.top) / bounds.height),
        };
    }

    function handleAt(point) {
        if (state.selectedIndex < 0) return null;
        const rectangle = state.rectangles[state.selectedIndex];
        if (!rectangle) return null;
        const [x, y, width, height] = rectangle.coordinates;
        const toleranceX = 11 / Math.max(1, canvas.clientWidth);
        const toleranceY = 11 / Math.max(1, canvas.clientHeight);
        const handles = {
            nw: [x, y],
            ne: [x + width, y],
            se: [x + width, y + height],
            sw: [x, y + height],
        };
        return Object.entries(handles).find(
            ([, [handleX, handleY]]) =>
                Math.abs(point.x - handleX) <= toleranceX && Math.abs(point.y - handleY) <= toleranceY,
        )?.[0] || null;
    }

    function rectangleAt(point) {
        for (let index = state.rectangles.length - 1; index >= 0; index -= 1) {
            const [x, y, width, height] = state.rectangles[index].coordinates;
            if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) {
                return index;
            }
        }
        return -1;
    }

    function pointerDown(event) {
        if (event.button !== 0) return;
        canvas.focus();
        const point = normalizedPointer(event);
        const handle = handleAt(point);
        const hitIndex = rectangleAt(point);
        const previous = cloneRectangles();

        if (event.shiftKey) {
            state.selectedIndex = -1;
            state.interaction = { kind: "draw", start: point, previous };
            state.draft = createRectangle([point.x, point.y, 0, 0]);
        } else if (handle && state.selectedIndex >= 0) {
            state.interaction = {
                kind: "resize",
                handle,
                start: point,
                origin: [...state.rectangles[state.selectedIndex].coordinates],
                previous,
            };
        } else if (hitIndex >= 0) {
            state.selectedIndex = hitIndex;
            state.interaction = {
                kind: "move",
                start: point,
                origin: [...state.rectangles[hitIndex].coordinates],
                previous,
            };
        } else {
            state.selectedIndex = -1;
            state.interaction = { kind: "draw", start: point, previous };
            state.draft = createRectangle([point.x, point.y, 0, 0]);
        }
        canvas.setPointerCapture(event.pointerId);
        renderAll();
        event.preventDefault();
    }

    function resizeCoordinates(origin, handle, point) {
        const [x, y, width, height] = origin;
        const right = x + width;
        const bottom = y + height;
        const minimumX = 4 / Math.max(1, canvas.clientWidth);
        const minimumY = 4 / Math.max(1, canvas.clientHeight);
        if (handle === "nw") {
            const nextX = clamp(point.x, 0, right - minimumX);
            const nextY = clamp(point.y, 0, bottom - minimumY);
            return [nextX, nextY, right - nextX, bottom - nextY];
        }
        if (handle === "ne") {
            const nextRight = clamp(point.x, x + minimumX, 1);
            const nextY = clamp(point.y, 0, bottom - minimumY);
            return [x, nextY, nextRight - x, bottom - nextY];
        }
        if (handle === "sw") {
            const nextX = clamp(point.x, 0, right - minimumX);
            const nextBottom = clamp(point.y, y + minimumY, 1);
            return [nextX, y, right - nextX, nextBottom - y];
        }
        const nextRight = clamp(point.x, x + minimumX, 1);
        const nextBottom = clamp(point.y, y + minimumY, 1);
        return [x, y, nextRight - x, nextBottom - y];
    }

    function pointerMove(event) {
        if (!state.interaction) return;
        const point = normalizedPointer(event);
        const interaction = state.interaction;
        if (interaction.kind === "draw") {
            const x = Math.min(interaction.start.x, point.x);
            const y = Math.min(interaction.start.y, point.y);
            state.draft.coordinates = [x, y, Math.abs(point.x - interaction.start.x), Math.abs(point.y - interaction.start.y)];
        } else if (interaction.kind === "move") {
            const [x, y, width, height] = interaction.origin;
            const deltaX = point.x - interaction.start.x;
            const deltaY = point.y - interaction.start.y;
            state.rectangles[state.selectedIndex].coordinates = [
                clamp(x + deltaX, 0, 1 - width),
                clamp(y + deltaY, 0, 1 - height),
                width,
                height,
            ];
        } else if (interaction.kind === "resize") {
            state.rectangles[state.selectedIndex].coordinates = resizeCoordinates(
                interaction.origin,
                interaction.handle,
                point,
            );
        }
        renderCanvas();
        event.preventDefault();
    }

    function finishInteraction(event, cancelled = false) {
        if (!state.interaction) return;
        const interaction = state.interaction;
        if (cancelled) {
            state.rectangles = interaction.previous;
        } else if (interaction.kind === "draw" && state.draft) {
            const [, , width, height] = state.draft.coordinates;
            const minimumWidth = 5 / Math.max(1, canvas.clientWidth);
            const minimumHeight = 5 / Math.max(1, canvas.clientHeight);
            if (width >= minimumWidth && height >= minimumHeight) {
                state.rectangles.push(state.draft);
                state.selectedIndex = state.rectangles.length - 1;
            }
        }
        state.draft = null;
        state.interaction = null;
        if (event?.pointerId !== undefined && canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
        }
        if (!cancelled) commitHistory(interaction.previous);
        else renderAll();
    }

    async function loadImageBlob(blob) {
        const objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error("The selected image could not be opened."));
            image.src = objectUrl;
        });
        URL.revokeObjectURL(objectUrl);
        state.image = image;
        state.imageWidth = image.naturalWidth;
        state.imageHeight = image.naturalHeight;
        resizeCanvas();
        renderControls();
    }

    async function captureFrame(showSuccess = true) {
        canvasLoading.hidden = false;
        try {
            const response = await fetch(`/api/ocr-area-selector/screenshot?t=${Date.now()}`, { cache: "no-store" });
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || "No server screenshot is currently available.");
            }
            await loadImageBlob(await response.blob());
            if (showSuccess) showStatus("Loaded the current OBS frame.");
        } catch (error) {
            showStatus(`${error.message} You can still open an image from this browser.`, true);
        } finally {
            canvasLoading.hidden = true;
        }
    }

    function applyLoadedConfig(config) {
        state.configName = config.name;
        state.scene = config.scene;
        state.isOverlay = Boolean(config.is_overlay);
        state.imageWidth = Number(config.image_size?.width) || 1920;
        state.imageHeight = Number(config.image_size?.height) || 1080;
        state.rectangles = Array.isArray(config.rectangles) ? config.rectangles : [];
        state.selectedIndex = -1;
        state.undoStack = [];
        state.redoStack = [];
        sceneName.textContent = config.scene || config.name;
        localStorage.setItem("gsmAreaSelectorConfig", config.name);
        setDirty(false);
        updateModeAvailability();
        resizeCanvas();
        renderAll();
    }

    async function loadConfig(name) {
        const response = await fetch(`/api/ocr-area-selector/config?name=${encodeURIComponent(name)}`, { cache: "no-store" });
        const config = await responseJson(response);
        applyLoadedConfig(config);
        configSelect.value = config.name;
    }

    function beginNewConfig(name) {
        const normalizedName = name.toLowerCase().endsWith(".json") ? name : `${name}.json`;
        const config = {
            name: normalizedName,
            scene: normalizedName.replace(/\.json$/i, "").replace(/_overlay$/i, ""),
            is_overlay: /_overlay\.json$/i.test(normalizedName),
            image_size: { width: state.imageWidth, height: state.imageHeight },
            rectangles: [],
        };
        if (![...configSelect.options].some((option) => option.value === normalizedName)) {
            configSelect.add(new Option(`${config.scene} (new)`, normalizedName));
        }
        configSelect.value = normalizedName;
        applyLoadedConfig(config);
        setDirty(true);
    }

    async function refreshConfigList(preferredName = "", loadPreferred = true) {
        const payload = await responseJson(await fetch("/api/ocr-area-selector/configs", { cache: "no-store" }));
        configSelect.replaceChildren();
        payload.configs.forEach((config) => {
            const suffix = config.is_overlay ? " · overlay" : "";
            configSelect.add(new Option(`${config.scene}${suffix}`, config.name));
        });

        const requested = preferredName || state.configName || localStorage.getItem("gsmAreaSelectorConfig");
        const selected = payload.configs.find((config) => config.name === requested) || payload.configs[0];
        if (selected) {
            configSelect.value = selected.name;
            if (loadPreferred) await loadConfig(selected.name);
        } else if (!state.configName) {
            beginNewConfig("Default.json");
        }
    }

    async function saveConfig() {
        if (!state.configName) return;
        const response = await fetch("/api/ocr-area-selector/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: state.configName,
                image_size: { width: state.imageWidth, height: state.imageHeight },
                rectangles: state.rectangles,
            }),
        });
        const payload = await responseJson(response);
        applyLoadedConfig(payload.config);
        await refreshConfigList(state.configName, false);
        configSelect.value = state.configName;
        showStatus(payload.message || "OCR areas saved.");
    }

    function confirmDiscard() {
        return !state.dirty || window.confirm("Discard the unsaved OCR area changes?");
    }

    document.querySelectorAll(".mode-button").forEach((button) => {
        button.addEventListener("click", () => setMode(button.dataset.mode));
    });
    document.getElementById("undoButton").addEventListener("click", undo);
    document.getElementById("redoButton").addEventListener("click", redo);
    document.getElementById("deleteButton").addEventListener("click", () => deleteRectangle());
    document.getElementById("selectAllButton").addEventListener("click", () => {
        const previous = cloneRectangles();
        state.rectangles.push(createRectangle([0, 0, 1, 1]));
        state.selectedIndex = state.rectangles.length - 1;
        commitHistory(previous);
    });
    document.getElementById("clearButton").addEventListener("click", () => {
        if (!state.rectangles.length || !window.confirm("Remove every OCR area from this config?")) return;
        const previous = cloneRectangles();
        state.rectangles = [];
        state.selectedIndex = -1;
        commitHistory(previous);
    });
    document.getElementById("captureButton").addEventListener("click", () => captureFrame());
    document.getElementById("uploadButton").addEventListener("click", () => imageInput.click());
    document.getElementById("saveButton").addEventListener("click", () => saveConfig().catch((error) => showStatus(error.message, true)));
    document.getElementById("refreshConfigsButton").addEventListener("click", () => {
        refreshConfigList(state.configName, false).catch((error) => showStatus(error.message, true));
    });
    document.getElementById("newConfigButton").addEventListener("click", () => {
        if (!confirmDiscard()) return;
        const name = window.prompt("New OCR config name", "Default.json");
        if (name?.trim()) beginNewConfig(name.trim());
    });

    configSelect.addEventListener("change", async () => {
        const nextName = configSelect.value;
        if (!confirmDiscard()) {
            configSelect.value = state.configName;
            return;
        }
        try {
            await loadConfig(nextName);
        } catch (error) {
            configSelect.value = state.configName;
            showStatus(error.message, true);
        }
    });

    imageInput.addEventListener("change", async () => {
        const file = imageInput.files?.[0];
        if (!file) return;
        try {
            await loadImageBlob(file);
            showStatus(`Opened ${file.name}.`);
        } catch (error) {
            showStatus(error.message, true);
        } finally {
            imageInput.value = "";
        }
    });

    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", (event) => finishInteraction(event));
    canvas.addEventListener("pointercancel", (event) => finishInteraction(event, true));

    window.addEventListener("keydown", (event) => {
        const modifier = event.ctrlKey || event.metaKey;
        if (modifier && event.key.toLowerCase() === "z") {
            event.preventDefault();
            event.shiftKey ? redo() : undo();
        } else if (modifier && event.key.toLowerCase() === "y") {
            event.preventDefault();
            redo();
        } else if (modifier && event.key.toLowerCase() === "s") {
            event.preventDefault();
            saveConfig().catch((error) => showStatus(error.message, true));
        } else if ((event.key === "Delete" || event.key === "Backspace") && document.activeElement === canvas) {
            event.preventDefault();
            deleteRectangle();
        } else if (event.key === "Escape" && state.interaction) {
            finishInteraction(null, true);
        }
    });

    window.addEventListener("beforeunload", (event) => {
        if (!state.dirty) return;
        event.preventDefault();
        event.returnValue = "";
    });

    new ResizeObserver(resizeCanvas).observe(canvasScroller);

    async function initialize() {
        try {
            const currentConfig = await responseJson(
                await fetch("/api/ocr-area-selector/current-config", { cache: "no-store" }),
            );
            applyLoadedConfig(currentConfig);
            await refreshConfigList(currentConfig.name, false);
            configSelect.value = currentConfig.name;
            await captureFrame(false);
        } catch (error) {
            showStatus(error.message, true);
            resizeCanvas();
            renderAll();
        }
    }

    initialize();
})();
