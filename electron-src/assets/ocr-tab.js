// OCR Tab Module
// This module handles all OCR-related functionality

(function () {
    'use strict';

    // Module state
    let current_scene_config = null;
    let ocr_settings = null;
    let scenes = [];
    let paused = false;
    let isScanning = false;
    let isSleeping = false;
    let animationFrame = 0;
    let sleepingAnimationFrame = 1;
    let iteration = 0;
    let speeds = {};
    let previous_message = "";
    let processes_using_console = 0;
    let ocrTerm = null;
    let ocrFitAddon = null;
    let platform = 'win32';
    let isManualOCR = false;

    // Animation constants
    const dotsAnimation = ['.', '..', '...', '....'];
    const scanningAnimation = ['.', '..', '...', '....'];

    // Engine colors configuration
    const engineColors = {
        "OneOCR": { ansi: "\x1b[36m", html: "color: #00FFFF;" },
        "Google Lens": { ansi: "\x1b[92m", html: "color: #00FF00;" },
        "Gemini": { ansi: "\x1b[95m", html: "color: #FF77FF;" },
        "Bing": { ansi: "\x1b[34m", html: "color: #0000FF;" },
        "EasyOCR": { ansi: "\x1b[33m", html: "color: #FFFF00;" },
        "RapidOCR": { ansi: "\x1b[35m", html: "color: #FF00FF;" },
        "Manga OCR": { ansi: "\x1b[95m", html: "color: #FF77FF;" },
        "WindowsOCR": { ansi: "\x1b[36m", html: "color: #00FFFF;" },
        "WinRT OCR": { ansi: "\x1b[36m", html: "color: #00FFFF;" },
        "Google Vision": { ansi: "\x1b[92m", html: "color: #00FF00;" },
        "Azure Image Analysis": { ansi: "\x1b[96m", html: "color: #00FFFF;" },
        "OCRSpace": { ansi: "\x1b[93m", html: "color: #FFFF00;" },
        "Qwen2-VL": { ansi: "\x1b[90m", html: "color: #808080;" },
        "Local LLM OCR": { ansi: "\x1b[95m", html: "color: #D6A4FF;" },
        "Meiki": { ansi: "\x1b[95m", html: "color: #ff00ff;" },
        "MeikiOCR": { ansi: "\x1b[95m", html: "color: #ff00ff;" },
    };

    // Utility functions
    function getEngineColor(engine, ansi = true) {
        return engineColors[engine]?.[ansi ? "ansi" : "html"] || "";
    }

    function getEngineFormatString(engine_name, textToFormat, ansi = true) {
        if (!engine_name) return textToFormat;
        const color = getEngineColor(engine_name, ansi);
        if (color) {
            return ansi ? `${color}${textToFormat}\x1b[0m` : `<span style="${color}">${textToFormat}</span>`;
        }
        return textToFormat;
    }

    function replaceEngineNameWithColor(text, ansi = true, endColor = true) {
        for (const engine in engineColors) {
            const color = getEngineColor(engine, ansi);
            const regex = new RegExp(`\\b${engine}\\b`, 'g');
            const end = endColor ? (ansi ? `\x1b[0m` : `</span>`) : '';
            text = text.replace(regex, ansi ? `${color}${engine}${end}` : `<span style="${color}">${engine}${end}</span>`);
        }
        return text;
    }

    function stopScanningAnimation() {
        try {
            ocrTerm.write('\r\x1b[2K');
        } catch (e) {
            // Terminal might be closed, ignore error
        }
        isScanning = false;
        isSleeping = false;
        animationFrame = 0;
        sleepingAnimationFrame = 1;
    }

    function openOCRConsole(closeConsoleButtonText, options = {}) {
        if (!closeConsoleButtonText) {
            closeConsoleButtonText = "Stop OCR (Open Settings)";
        }
        processes_using_console++;

        const {
            hideConfigCard = true,
            hideSettingsCard = false,
            showLogCard = true,
            hideStartControls = true,
            showStopControls = true,
            hideManualHotkey = true,
            hideAreaHotkey = true,
            hideGlobalPauseHotkey = true,
            hideScreenshotsGroup = true,
            showSelectAreasButton = true,
            updateSettingsHeader = true,
            fitIntervalMs = 500,
        } = options;

        if (hideConfigCard)
            document.getElementById('config-card').style.display = 'none';
        if (hideSettingsCard)
            document.getElementById('ocr-settings-card').style.display = 'none';
        if (showLogCard)
            document.getElementById('ocr-log-card').style.display = 'block';
        if (hideStartControls)
            document.getElementById('start-ocr-controls').style.display = 'none';
        if (showStopControls)
            document.getElementById('stop-ocr-controls').style.display = 'flex';
        document.getElementById('stop-ocr').innerText = closeConsoleButtonText;
        if (hideManualHotkey)
            document.getElementById('manual-ocr-hotkey-group').style.display = 'none';
        if (hideAreaHotkey)
            document.getElementById('area-select-ocr-hotkey-group').style.display = 'none';
        if (hideGlobalPauseHotkey)
            document.getElementById('global-pause-hotkey-group').style.display = 'none';
        if (updateSettingsHeader)
            document.getElementById('settings-header').firstChild.innerText = 'OCR Settings (Some Options Hidden)';
        if (hideScreenshotsGroup)
            document.getElementById('ocr-screenshots-group').style.display = 'none';
        if (showSelectAreasButton) {
            const isBasicMode = !document.getElementById('settings-mode-toggle').checked;
            if (isBasicMode) {
                document.getElementById('select_areas_button_basic').style.display = 'block';
            } else {
                document.getElementById('select_areas_button_2').style.display = 'block';
            }
        }

        setInterval(() => ocrFitAddon.fit(), fitIntervalMs);
    }

    function closeOCRConsole() {
        processes_using_console--;
        if (processes_using_console > 0) return;

        stopScanningAnimation();
        ['settings-header', 'config-header'].forEach(id => {
            toggleCollapsibleSectionById(id, true);
        });

        document.getElementById('config-card').style.display = 'block';
        document.getElementById('ocr-settings-card').style.display = 'block';
        document.getElementById('ocr-log-card').style.display = 'none';
        document.getElementById('start-ocr-controls').style.display = 'flex';
        document.getElementById('stop-ocr-controls').style.display = 'none';
        document.getElementById('stop-ocr').innerText = "Stop OCR (Open Settings)";
        document.getElementById('manual-ocr-hotkey-group').style.display = 'flex';
        document.getElementById('area-select-ocr-hotkey-group').style.display = 'flex';
        document.getElementById('global-pause-hotkey-group').style.display = 'flex';
        document.getElementById('two-pass-ocr-group').style.display = 'flex';
        document.getElementById('settings-header').firstChild.innerText = '3. OCR Settings';
        document.getElementById('ocr-screenshots-group').style.display = 'flex';
        document.getElementById('ocr-status-label').innerText = "";
        document.getElementById('select_areas_button_2').style.display = 'none';
        document.getElementById('select_areas_button_basic').style.display = 'none';
        refreshActiveOCRWindow();
    }

    function refreshActiveOCRWindow() {
        ipcRenderer.invoke('ocr.getActiveOCRConfig').then(config => {
            if (!config) {
                document.getElementById('config-tooltip').innerText = '✗';
                document.getElementById('ocr-config-summary').textContent = 'No active OCR configuration found.';
                return;
            }
            const furiganaSensitivity = config.furiganaFilterSensitivity;
            document.getElementById('furigana-filter-sensitivity').value = Number(furiganaSensitivity) || 0;
            document.getElementById('furigana-filter-sensitivity-value').textContent = furiganaSensitivity || 0;

            // Update local state to match scene config
            if (ocr_settings) {
                ocr_settings.furigana_filter_sensitivity = Number(furiganaSensitivity) || 0;
            }

            document.getElementById('config-tooltip').innerText = '✓';
            document.getElementById('ocr-config-summary').innerHTML = `Selected Config: ${config.scene || 'None'}<br> Rectangles: ${config.rectangles?.length || 0}`;
        });
    }

    function refreshScenesAndWindows(showLoading = true) {
        const sceneSelect = document.getElementById('sceneSelect');
        const previousSceneSelection = sceneSelect.value;

        if (showLoading)
            sceneSelect.innerHTML = '<option>Loading...</option>';

        ipcRenderer.invoke('obs.getScenes').then(obsScenes => {
            scenes = obsScenes;
            sceneSelect.innerHTML = '';
            scenes.forEach(scene => {
                const option = document.createElement('option');
                option.value = scene.id;
                option.textContent = scene.name;
                sceneSelect.appendChild(option);
            });

            if (previousSceneSelection && scenes.some(s => s.id === previousSceneSelection)) {
                sceneSelect.value = previousSceneSelection;
            } else {
                sceneSelect.value = scenes[0]?.id || '';
            }

            ipcRenderer.invoke('obs.getActiveScene').then(activeScene => {
                if (activeScene && scenes.some(s => s.id === activeScene.id)) {
                    sceneSelect.value = activeScene.id;
                }
            });
            refreshActiveOCRWindow();
        });
    }

    async function saveOCRConfig() {
        const isAdvancedMode = document.getElementById('settings-mode-toggle').checked;
        const scanRate = isAdvancedMode
            ? document.getElementById('ocr-scan-rate').value
            : document.getElementById('text-appearance-speed').value;

        const current_ocr1 = document.getElementById('ocr1-input').value;
        const current_ocr2 = document.getElementById('ocr2-input').value;

        // Construct the update object
        ocr_settings = {
            ...ocr_settings, // Keep existing settings
            twoPassOCR: document.getElementById('two-pass-ocr').checked,
            // optimize_second_scan is Advanced only, so we only update it if in Advanced mode
            // BUT wait, if we are in Basic mode, we don't want to change it.
            // The DOM element still exists. If we read it, we get the current state.
            // Since we stopped forcing it in toggleSettingsMode, the DOM state should be correct.
            optimize_second_scan: document.getElementById('optimize-second-scan').checked,
            scanRate: parseFloat(scanRate),
            language: document.getElementById('languageSelect').value,
            ocr_screenshots: document.getElementById('ocr-screenshots').checked,
            furigana_filter_sensitivity: parseInt(document.getElementById('furigana-filter-sensitivity').value),
            manualOcrHotkey: document.getElementById('manual-ocr-hotkey').value,
            areaSelectOcrHotkey: document.getElementById('area-select-ocr-hotkey').value,
            globalPauseHotkey: document.getElementById('global-pause-hotkey').value,
            sendToClipboard: document.getElementById('send-to-clipboard').checked,
            keep_newline: document.getElementById('keep-newline').checked,
            advancedMode: isAdvancedMode,
        };

        // Update the specific slots based on mode
        if (isAdvancedMode) {
            ocr_settings.ocr1 = current_ocr1;
            ocr_settings.ocr2 = current_ocr2;
            ocr_settings.ocr1_advanced = current_ocr1;
            ocr_settings.ocr2_advanced = current_ocr2;
            ocr_settings.scanRate_advanced = parseFloat(scanRate);
        } else {
            let defaultOcr1 = 'oneocr';
            if (platform === 'darwin') {
                defaultOcr1 = 'alivetext';
            } else if (platform === 'linux') {
                defaultOcr1 = 'meiki_text_detector';
            }
            ocr_settings.ocr1 = defaultOcr1;
            ocr_settings.ocr2 = 'glens';
            ocr_settings.scanRate_basic = parseFloat(scanRate);
        }

        await ipcRenderer.send('ocr.save-ocr-config', ocr_settings);
    }

    async function toggleSettingsMode(isAdvanced, skipSave = false) {
        // Capture current UI values into ocr_settings before switching
        if (!skipSave) {
            const wasAdvanced = !isAdvanced;
            const current_ocr1 = document.getElementById('ocr1-input').value;
            const current_ocr2 = document.getElementById('ocr2-input').value;
            const current_scanRate = wasAdvanced
                ? document.getElementById('ocr-scan-rate').value
                : document.getElementById('text-appearance-speed').value;

            if (ocr_settings) {
                if (wasAdvanced) {
                    ocr_settings.ocr1_advanced = current_ocr1;
                    ocr_settings.ocr2_advanced = current_ocr2;
                    ocr_settings.scanRate_advanced = current_scanRate;
                } else {
                    ocr_settings.scanRate_basic = current_scanRate;
                }
            }
        }

        const basicSettings = document.getElementById('ocr-basic-settings');
        const advancedSettings = document.getElementById('ocr-settings-grid-container');

        const furiganaGroup = document.getElementById('furigana-filter-group');
        const manualHotkeyGroup = document.getElementById('manual-ocr-hotkey-group');
        const areaHotkeyGroup = document.getElementById('area-select-ocr-hotkey-group');
        const globalPauseHotkeyGroup = document.getElementById('global-pause-hotkey-group');
        const clipboardGroup = document.getElementById('send-to-clipboard-group');
        const languageGroup = document.getElementById('language-select-group');

        let defaultOcr1 = 'oneocr';
        if (platform === 'darwin') {
            defaultOcr1 = 'alivetext'; // Actually 'macocr' or 'alivetext' depending on what we support
        } else if (platform === 'linux') {
            defaultOcr1 = 'meiki_text_detector';
        }

        if (isAdvanced) {
            basicSettings.style.display = 'none';
            advancedSettings.style.display = 'grid';

            // Move shared elements back to advanced grid
            const firstColumn = document.querySelector('#ocr-settings-grid-container .form-group:nth-child(1)');
            const secondColumn = document.querySelector('#ocr-settings-grid-container .form-group:nth-child(2)');

            if (languageGroup && languageGroup.parentElement.id === 'language-select-group-basic') {
                const ocr2Group = document.getElementById('ocr2-select-group');
                if (ocr2Group && ocr2Group.parentElement === firstColumn) {
                    ocr2Group.parentNode.insertBefore(languageGroup, ocr2Group.nextSibling);
                }
            }

            if (furiganaGroup && furiganaGroup.parentElement.id === 'furigana-filter-group-basic') {
                const optimizeGroup = document.getElementById('optimize-second-scan-group');
                if (optimizeGroup && optimizeGroup.parentElement === firstColumn) {
                    optimizeGroup.parentNode.insertBefore(furiganaGroup, optimizeGroup.nextSibling);
                }
            }

            if (areaHotkeyGroup && areaHotkeyGroup.parentElement.id === 'area-select-ocr-hotkey-group-basic') {
                const scanRateGroup = document.getElementById('ocr-scan-rate-group');
                if (scanRateGroup && scanRateGroup.parentElement === secondColumn) {
                    scanRateGroup.parentNode.insertBefore(areaHotkeyGroup, scanRateGroup.nextSibling);
                }
            }

            if (manualHotkeyGroup && manualHotkeyGroup.parentElement.id === 'manual-ocr-hotkey-group-basic') {
                if (areaHotkeyGroup && areaHotkeyGroup.parentElement === secondColumn) {
                    areaHotkeyGroup.parentNode.insertBefore(manualHotkeyGroup, areaHotkeyGroup.nextSibling);
                }
            }

            if (globalPauseHotkeyGroup && globalPauseHotkeyGroup.parentElement.id === 'global-pause-hotkey-group-basic') {
                if (manualHotkeyGroup && manualHotkeyGroup.parentElement === secondColumn) {
                    manualHotkeyGroup.parentNode.insertBefore(globalPauseHotkeyGroup, manualHotkeyGroup.nextSibling);
                }
            }

            if (clipboardGroup && clipboardGroup.parentElement.id === 'send-to-clipboard-group-basic') {
                const screenshotsGroup = document.getElementById('ocr-screenshots-group');
                if (screenshotsGroup && screenshotsGroup.parentElement === secondColumn) {
                    screenshotsGroup.parentNode.insertBefore(clipboardGroup, screenshotsGroup.nextSibling);
                }
            }

            // Load Advanced Configs
            document.getElementById('ocr1-input').value = ocr_settings.ocr1_advanced || defaultOcr1;
            document.getElementById('ocr2-input').value = ocr_settings.ocr2_advanced || 'glens';
            document.getElementById('ocr-scan-rate').value = ocr_settings.scanRate_advanced || 0.5;

        } else {
            basicSettings.style.display = 'grid';
            advancedSettings.style.display = 'none';

            // Move shared elements to basic grid
            if (languageGroup) {
                document.getElementById('language-select-group-basic').appendChild(languageGroup);
            }
            if (furiganaGroup) {
                document.getElementById('furigana-filter-group-basic').appendChild(furiganaGroup);
            }
            if (manualHotkeyGroup) {
                document.getElementById('manual-ocr-hotkey-group-basic').appendChild(manualHotkeyGroup);
            }
            if (areaHotkeyGroup) {
                document.getElementById('area-select-ocr-hotkey-group-basic').appendChild(areaHotkeyGroup);
            }
            if (globalPauseHotkeyGroup) {
                document.getElementById('global-pause-hotkey-group-basic').appendChild(globalPauseHotkeyGroup);
            }
            if (clipboardGroup) {
                document.getElementById('send-to-clipboard-group-basic').appendChild(clipboardGroup);
            }

            // Load Basic Configs
            document.getElementById('ocr1-input').value = defaultOcr1;
            document.getElementById('ocr2-input').value = 'glens';

            const scanRate = ocr_settings.scanRate_basic || 0.5;
            const appearanceSpeed = document.getElementById('text-appearance-speed');
            // Map scanRate to appearance speed dropdown
            if (scanRate <= 0.3) {
                appearanceSpeed.value = '0.2';
            } else if (scanRate <= 0.65) {
                appearanceSpeed.value = '0.5';
            } else {
                appearanceSpeed.value = '0.8';
            }
            // Update the hidden scan rate input too, just in case
            document.getElementById('ocr-scan-rate').value = scanRate;
        }
    }

    function setupCollapsibleSections() {
        document.querySelectorAll('.collapsible-header').forEach(header => {
            if (header.id === 'settings-header') {
                return;
            }
            header.addEventListener('click', () => {
                toggleCollapsibleSection(header);
            });
        });
    }

    function toggleCollapsibleSection(header, forceState) {
        const content = header.nextElementSibling;
        const arrow = header.querySelector('.arrow-icon');
        const isHidden = content.style.display === 'none';
        const shouldShow = forceState === undefined ? isHidden : forceState;

        content.style.display = shouldShow ? 'block' : 'none';
        if (arrow) {
            arrow.textContent = shouldShow ? '▲' : '▼';
        }
        if (content.id === 'ocr-terminal') {
            ocrFitAddon.fit();
        }
    }

    function toggleCollapsibleSectionById(id, forceState) {
        const header = document.getElementById(id);
        if (header && header.classList.contains('collapsible-header')) {
            toggleCollapsibleSection(header, forceState);
        }
    }

    const setHotkey = (event, inputElement) => {
        event.preventDefault();
        const keys = [];
        if (event.ctrlKey) keys.push('Ctrl');
        if (event.shiftKey) keys.push('Shift');
        if (event.altKey) keys.push('Alt');
        if (event.key && !['Control', 'Shift', 'Alt'].includes(event.key)) keys.push(event.key.toUpperCase());
        inputElement.value = keys.join('+');
        saveOCRConfig();
    };

    // Terminal setup
    function initializeTerminal() {
        ocrTerm = new Terminal({
            convertEol: true,
            fontFamily: '"Noto Sans Mono", "IPA Gothic", "Courier New", monospace',
            fontSize: 14,
            disableStdin: false,
            theme: {
                foreground: "#EEEEEE",
                background: "#2c2c2c",
                cursor: "#CFF5DB"
            },
            allowTransparency: true,
        });

        ocrFitAddon = new FitAddon.FitAddon();
        ocrTerm.loadAddon(ocrFitAddon);
        ocrTerm.open(document.getElementById('ocr-terminal'));
        document.getElementById('ocr-terminal').style.height = '300px';
        ocrFitAddon.fit();

        ocrTerm.onData(e => {
            ipcRenderer.send('ocr.stdin', e);
        });

        ocrTerm.attachCustomKeyEventHandler((arg) => {
            if (arg.ctrlKey && arg.code === "KeyC" && arg.type === "keydown") {
                const selection = ocrTerm.getSelection();
                if (selection) {
                    clipboard.writeText(selection);
                    return false;
                }
            }
            return true;
        });

        document.getElementById("ocr-terminal").addEventListener('contextmenu', () => {
            if (ocrTerm.hasSelection()) {
                document.execCommand('copy');
                ocrTerm.select(0, 0, 0);
            }
        });
    }

    // Event handlers setup
    function setupEventHandlers() {
        // Wiki button
        document.getElementById('open-ocr-wiki-btn').addEventListener('click', () => {
            window.open('https://github.com/bpwhelan/GameSentenceMiner/wiki/OCR-%E2%80%90-Area-Selector', '_blank');
        });

        // Import/Export config
        document.getElementById('import-config-btn').addEventListener('click', async () => {
            const result = await ipcRenderer.invoke('ocr.import-ocr-config');
            if (result.success) {
                alert('Import successful!');
                loadCurrentConfig();
            } else {
                alert('Import failed: ' + result.message);
            }
        });

        document.getElementById('export-config-btn').addEventListener('click', async () => {
            const result = await ipcRenderer.invoke('ocr.export-ocr-config');
            if (result.success) {
                alert('Exported Config to Clipboard!');
            } else {
                alert('Export failed: ' + result.message);
            }
        });

        // Furigana preview
        document.getElementById('dynamic-size-display').addEventListener('click', async () => {
            const sensitivity = await ipcRenderer.invoke('run-furigana-window');
            console.log('Furigana filter sensitivity set to:', sensitivity);
            document.getElementById('furigana-filter-sensitivity').value = sensitivity;
            document.getElementById('furigana-filter-sensitivity-value').innerText = sensitivity;
        });

        // Hotkey inputs
        const manualOcrHotkeyInput = document.getElementById('manual-ocr-hotkey');
        const areaSelectOCRHotkeyInput = document.getElementById('area-select-ocr-hotkey');
        const globalPauseHotkeyInput = document.getElementById('global-pause-hotkey');
        manualOcrHotkeyInput.addEventListener('keydown', (e) => setHotkey(e, manualOcrHotkeyInput));
        areaSelectOCRHotkeyInput.addEventListener('keydown', (e) => setHotkey(e, areaSelectOCRHotkeyInput));
        globalPauseHotkeyInput.addEventListener('keydown', (e) => setHotkey(e, globalPauseHotkeyInput));

        // Furigana filter
        const furiganaFilterSlider = document.getElementById('furigana-filter-sensitivity');
        const furiganaFilterValue = document.getElementById('furigana-filter-sensitivity-value');
        furiganaFilterSlider.addEventListener('input', () => {
            const sensitivity = furiganaFilterSlider.value;
            furiganaFilterValue.textContent = sensitivity;
            ipcRenderer.send('update-furigana-character', "龍", sensitivity);
            saveOCRConfig();
        });

        // OCR page button
        document.getElementById('open-ocr-page-btn').addEventListener('click', () => {
            window.location.href = 'ocr_replacements.html';
        });

        // Checkbox listeners
        document.getElementById('send-to-clipboard').addEventListener('change', saveOCRConfig);
        document.getElementById('keep-newline').addEventListener('change', saveOCRConfig);

        // Dependency installation
        document.getElementById('install-selected-dep').addEventListener('click', () => {
            const selectedDep = document.getElementById('dependency-select').value;
            openOCRConsole("Close Console", {
                hideConfigCard: true,
                hideSettingsCard: true,
                showLogCard: true,
                hideStartControls: true,
                showStopControls: true,
                hideManualHotkey: false,
                hideAreaHotkey: false,
                hideGlobalPauseHotkey: false,
                hideScreenshotsGroup: false,
                showSelectAreasButton: false,
                updateSettingsHeader: false,
                fitIntervalMs: 500,
            });
            ipcRenderer.send('ocr.install-selected-dep', selectedDep);
        });

        document.getElementById('uninstall-selected-dep').addEventListener('click', () => {
            const selectedDep = document.getElementById('dependency-select-removal').value;
            ipcRenderer.send('ocr.uninstall-selected-dep', selectedDep);
        });

        // Area selector buttons
        ['run-screen-selector', 'select-areas-button', 'select-areas-button-basic'].forEach(id => {
            const element = document.getElementById(id);
            if (!element) return;
            element.addEventListener('click', async () => {
                const hideSettingsCard = (id === "run-screen-selector");
                openOCRConsole("Close Console", {
                    hideConfigCard: false,
                    hideSettingsCard: hideSettingsCard,
                    showLogCard: true,
                    hideStartControls: true,
                    showStopControls: true,
                    hideManualHotkey: false,
                    hideAreaHotkey: false,
                    hideGlobalPauseHotkey: false,
                    hideScreenshotsGroup: false,
                    showSelectAreasButton: false,
                    updateSettingsHeader: false,
                    fitIntervalMs: 500,
                });
                await ipcRenderer.send('ocr.run-screen-selector');
            });
        });

        // Config/folder buttons
        document.getElementById('open-config-json').addEventListener('click', () => ipcRenderer.invoke('ocr.open-config-json'));
        document.getElementById('open-config-folder').addEventListener('click', () => ipcRenderer.invoke('ocr.open-config-folder'));
        document.getElementById('open-global-owocr-config').addEventListener('click', () => ipcRenderer.invoke('ocr.open-global-owocr-config'));
        document.getElementById('open-temp-folder').addEventListener('click', () => ipcRenderer.invoke('ocr.open-temp-folder'));

        // Start/Stop OCR
        document.getElementById('start-ocr').addEventListener('click', () => {
            isManualOCR = false;
            ocrTerm.clear();
            stopScanningAnimation();
            saveOCRConfig();
            ipcRenderer.send('ocr.start-ocr');
        });

        document.getElementById('start-ocr-ss-only').addEventListener('click', () => {
            isManualOCR = true;
            ocrTerm.clear();
            stopScanningAnimation();
            saveOCRConfig();
            ipcRenderer.send('ocr.start-ocr-ss-only');
        });

        document.getElementById('stop-ocr').addEventListener('click', () => {
            ipcRenderer.send('ocr.kill-ocr');
            closeOCRConsole();
        });

        document.getElementById('pause-ocr').addEventListener('click', () => {
            // Use new IPC system to toggle pause
            // Don't update UI here - let the IPC events handle it to avoid race conditions
            ipcRenderer.send('ocr.toggle-pause');
        });

        // Scene selection
        document.getElementById('sceneSelect').addEventListener('change', (event) => {
            ipcRenderer.invoke('obs.switchScene.id', event.target.value);
            setTimeout(() => refreshActiveOCRWindow(), 500);
        });

        document.getElementById('refreshScenesBtn').addEventListener('click', refreshScenesAndWindows);

        // OCR settings listeners
        ['two-pass-ocr', 'ocr1-input', 'ocr2-input', 'ocr-scan-rate', 'languageSelect', 'ocr-screenshots', 'optimize-second-scan'].forEach(id => {
            if (id === 'two-pass-ocr') {
                document.getElementById('two-pass-ocr').addEventListener('change', (event) => {
                    if (event.target.checked) {
                        document.getElementById('ocr1-select-group').style.display = 'flex';
                        document.getElementById('optimize-second-scan-group').style.display = 'flex';
                    } else {
                        document.getElementById('ocr1-select-group').style.display = 'none';
                        document.getElementById('optimize-second-scan-group').style.display = 'none';
                    }
                });
            }
            document.getElementById(id).addEventListener('change', saveOCRConfig);
        });

        // Mode toggle
        document.getElementById('settings-mode-toggle').addEventListener('change', async (e) => {
            await toggleSettingsMode(e.target.checked);
            await saveOCRConfig();
        });

        // Appearance speed
        document.getElementById('text-appearance-speed').addEventListener('change', saveOCRConfig);
    }

    // IPC event listeners
    function setupIpcListeners() {
        ipcRenderer.on('ocr-log', (event, data) => {
            iteration += 1;
            const trimmedData = data.trim();
            const trimmedDataLower = trimmedData.toLowerCase();
            const engine_name = trimmedData.includes("using") ? trimmedData.split("using")[1].split(":")[0].trim() : "";
            let engine_pretty_ansi = getEngineFormatString(engine_name, engine_name, true);
            let engine_pretty_html = getEngineFormatString(engine_name, engine_name, false);

            if (trimmedDataLower.includes("failed to load cu") || trimmedDataLower.includes("please follow https://onnxruntime.ai"))
                return; // Ignore CUDA errors for now

            if (trimmedData.endsWith("sleeping.")) {
                if (!isSleeping) {
                    isSleeping = true;
                } else if (isSleeping || ocr_settings?.scanRate > 0.5) {
                    document.getElementById('ocr-status-label').innerHTML = "<b>Status</b>: Sleeping - Image empty or unchanged" + '<span style="font-size: 2.0em;">' + dotsAnimation[sleepingAnimationFrame] + '</span>';
                    sleepingAnimationFrame = (sleepingAnimationFrame + 1) % dotsAnimation.length;
                }
                return;
            }

            if (trimmedData.includes("COMMAND_FINISHED")) {
                closeOCRConsole();
                return;
            }

            if (trimmedData.endsWith(engine_name + ":") && !paused) {
                if (speeds[engine_name] === undefined || iteration % 5 === 0) {
                    speeds[engine_name] = trimmedData.split(" in ")[1]?.split("s")[0]?.trim() || "0";
                }

                if (speeds[engine_name] !== 0) {
                    document.getElementById('ocr-status-label').innerHTML = "<b>Status</b>: Scanning using " + engine_pretty_html + ' in ' + speeds[engine_name] + 's' + '<span style="font-size: 2.0em;">' + scanningAnimation[animationFrame] + '</span>';
                } else {
                    document.getElementById('ocr-status-label').innerHTML = "<b>Status</b>: Scanning using " + engine_pretty_html + '<span style="font-size: 2.0em;">' + scanningAnimation[animationFrame] + '</span>';
                }
                animationFrame = (animationFrame + 1) % scanningAnimation.length;
            } else if (trimmedData.includes("Seems like Text we already sent")) {
                ocrTerm.write('\r\x1b[2K');
                ocrTerm.write(`\x1b[33m${previous_message} (Duplicate)\x1b[0m\n`);
            } else if (trimmedData.includes("Multiple active video sources found in OBS")) {
                const source_name = trimmedData.split("Multiple active video sources found in OBS. Using ")[1]?.split(" for Screenshot")[0]?.trim() || "Unknown Source";
                stopScanningAnimation();
                ocrTerm.writeln(getEngineFormatString(engine_name, replaceEngineNameWithColor(trimmedData, true), true));
                ipcRenderer.invoke('show-error-box', {
                    title: 'Multiple OBS Video Sources Detected',
                    message: 'Multiple active video sources were found in OBS. Please ensure only one source is active for OCR to function correctly.',
                    detail: 'Having multiple active video sources can lead to unexpected behavior. Please disable any unnecessary sources and try again.\n\nFor now, the source "' + source_name + '" will be used for OCR.'
                });
                previous_message = trimmedData;
            } else if (trimmedData) {
                stopScanningAnimation();
                ocrTerm.writeln(getEngineFormatString(engine_name, replaceEngineNameWithColor(trimmedData, true, !trimmedData.includes("Text recognized")), true));
                previous_message = trimmedData;
            }
        });

        ipcRenderer.on('ocr-started', () => {
            paused = false;
            const pauseBtn = document.getElementById('pause-ocr');
            if (pauseBtn) pauseBtn.innerText = 'Pause OCR';

            openOCRConsole("Stop OCR (Open Settings)", {
                hideConfigCard: true,
                showLogCard: true,
                hideStartControls: true,
                showStopControls: true,
                hideManualHotkey: true,
                hideAreaHotkey: true,
                hideGlobalPauseHotkey: true,
                hideScreenshotsGroup: true,
                showSelectAreasButton: true,
                updateSettingsHeader: false,
                fitIntervalMs: 500,
            });
        });

        ipcRenderer.on('ocr-stopped', () => {
            // closeOCRConsole();
        });

        // OCR IPC Event Handlers
        ipcRenderer.on('ocr-ipc-message', (event, msg) => {
            console.log('OCR IPC Message:', msg);
        });

        ipcRenderer.on('ocr-ipc-started', () => {
            console.log('OCR IPC: Process started');
        });

        ipcRenderer.on('ocr-ipc-stopped', () => {
            console.log('OCR IPC: Process stopped');
        });

        ipcRenderer.on('ocr-ipc-paused', (event, data) => {
            console.log('OCR IPC: Paused', data);
            paused = true;
            stopScanningAnimation();
            document.getElementById('ocr-status-label').innerHTML = "<b>Status</b>: <span style='color: orange;'>⏸️ Paused</span>";

            // Update button text
            const pauseBtn = document.getElementById('pause-ocr');
            if (pauseBtn) pauseBtn.innerText = 'Resume OCR';
        });

        ipcRenderer.on('ocr-ipc-unpaused', (event, data) => {
            console.log('OCR IPC: Unpaused', data);
            paused = false;
            document.getElementById('ocr-status-label').innerHTML = "<b>Status</b>: <span style='color: green;'>▶️ Running</span>";

            // Update button text
            const pauseBtn = document.getElementById('pause-ocr');
            if (pauseBtn) pauseBtn.innerText = 'Pause OCR';
        });

        ipcRenderer.on('ocr-ipc-status', (event, status) => {
            console.log('OCR IPC: Status update', status);
            paused = status.paused || false;
            if (status.manual !== undefined) {
                isManualOCR = status.manual;
            }

            // Update pause button text based on status
            const pauseBtn = document.getElementById('pause-ocr');
            if (pauseBtn) {
                pauseBtn.innerText = status.paused ? 'Resume OCR' : 'Pause OCR';
            }

            if (status.paused) {
                stopScanningAnimation();
                document.getElementById('ocr-status-label').innerHTML = "<b>Status</b>: <span style='color: orange;'>⏸️ Paused</span>";
            } else {
                const engine = status.current_engine || 'OCR';
                const scanRate = status.scan_rate || 0;
                if (isManualOCR) {
                    document.getElementById('ocr-status-label').innerHTML =
                        `<b>Status</b>: Running (${getEngineFormatString(engine, engine, false)})`;
                } else {
                    document.getElementById('ocr-status-label').innerHTML =
                        `<b>Status</b>: Running (${getEngineFormatString(engine, engine, false)}, ${scanRate}s scan rate)`;
                }
            }
        });

        ipcRenderer.on('ocr-ipc-error', (event, error) => {
            console.error('OCR IPC: Error', error);
            stopScanningAnimation();
            document.getElementById('ocr-status-label').innerHTML =
                `<b>Status</b>: <span style='color: red;'>❌ Error: ${error}</span>`;
        });

        ipcRenderer.on('ocr-ipc-config-reloaded', () => {
            console.log('OCR IPC: Config reloaded');
            ocrTerm?.writeln('\x1b[36mConfiguration reloaded\x1b[0m');
        });

        ipcRenderer.on('ocr-ipc-force-stable-changed', (event, data) => {
            console.log('OCR IPC: Force stable changed', data);
            const status = data.enabled ? 'enabled' : 'disabled';
            ocrTerm?.writeln(`\x1b[35mForce stable mode ${status}\x1b[0m`);
        });
    }

    // Initialize function
    async function initialize() {
        ocr_settings = await ipcRenderer.invoke('ocr.get-ocr-config');
        platform = await ipcRenderer.invoke('get-platform');
        console.log('Loaded OCR Settings:', ocr_settings);
        console.log('Platform:', platform);

        let defaultOcr1 = 'oneocr';
        if (platform === 'darwin') {
            defaultOcr1 = 'alivetext';
        } else if (platform === 'linux') {
            defaultOcr1 = 'meiki_text_detector';
        }

        if (ocr_settings) {
            document.getElementById('ocr1-input').value = ocr_settings.ocr1 || defaultOcr1;
            document.getElementById('ocr2-input').value = ocr_settings.ocr2 || 'glens';
            document.getElementById('two-pass-ocr').checked = ocr_settings.twoPassOCR;
            document.getElementById('optimize-second-scan').checked = ocr_settings.optimize_second_scan === undefined ? true : ocr_settings.optimize_second_scan;
            document.getElementById('ocr-scan-rate').value = ocr_settings.scanRate || 0.5;
            document.getElementById('languageSelect').value = ocr_settings.language || 'ja';
            document.getElementById('ocr-screenshots').checked = ocr_settings.ocr_screenshots;
            document.getElementById('keep-newline').checked = ocr_settings.keep_newline;
            document.getElementById('send-to-clipboard').checked = ocr_settings.sendToClipboard;

            if (ocr_settings.twoPassOCR) {
                document.getElementById('ocr1-select-group').style.display = 'flex';
                document.getElementById('optimize-second-scan-group').style.display = 'flex';
            } else {
                document.getElementById('ocr1-select-group').style.display = 'none';
                document.getElementById('optimize-second-scan-group').style.display = 'none';
            }

            const sensitivity = ocr_settings.furigana_filter_sensitivity || 0;
            document.getElementById('furigana-filter-sensitivity').value = sensitivity;
            document.getElementById('furigana-filter-sensitivity-value').textContent = sensitivity;

            document.getElementById('manual-ocr-hotkey').value = ocr_settings.manualOcrHotkey || 'Ctrl+Shift+G';
            document.getElementById('area-select-ocr-hotkey').value = ocr_settings.areaSelectOcrHotkey || 'Ctrl+Shift+O';
            document.getElementById('global-pause-hotkey').value = ocr_settings.globalPauseHotkey || 'Ctrl+Shift+P';

            const advancedMode = ocr_settings.advancedMode || false;
            document.getElementById('settings-mode-toggle').checked = advancedMode;
            toggleSettingsMode(advancedMode, true);

            const scanRate = ocr_settings.scanRate || 0.5;
            const appearanceSpeed = document.getElementById('text-appearance-speed');
            if (scanRate <= 0.3) {
                appearanceSpeed.value = '0.2';
            } else if (scanRate <= 0.65) {
                appearanceSpeed.value = '0.5';
            } else {
                appearanceSpeed.value = '0.8';
            }
        } else {
            document.getElementById('ocr1-input').value = defaultOcr1;
            document.getElementById('ocr2-input').value = 'glens';
        }

        refreshScenesAndWindows();
        setInterval(() => refreshScenesAndWindows(false), 5000);

        // Poll for OCR status periodically when controls are visible
        setInterval(() => {
            const stopControls = document.getElementById('stop-ocr-controls');
            if (stopControls && stopControls.style.display !== 'none') {
                ipcRenderer.send('ocr.get-status');
            }
        }, 5000);

        // Check if OCR was started before we loaded (e.g., on app startup via --ocr flag or OBS scene trigger)
        const runningState = await ipcRenderer.invoke('ocr.get-running-state');
        if (runningState && runningState.isRunning) {
            openOCRConsole("Stop OCR (Open Settings)", {
                hideConfigCard: true,
                showLogCard: true,
                hideStartControls: true,
                showStopControls: true,
                hideManualHotkey: true,
                hideAreaHotkey: true,
                hideGlobalPauseHotkey: true,
                hideScreenshotsGroup: true,
                showSelectAreasButton: true,
                updateSettingsHeader: false,
                fitIntervalMs: 500,
            });
        }
    }

    // Main initialization when DOM is ready
    function init() {
        initializeTerminal();
        setupEventHandlers();
        setupIpcListeners();
        setupCollapsibleSections();
        initialize();
    }

    // Export init function to be called from index.html
    if (typeof window !== 'undefined') {
        window.initOCRTab = init;
    }
})();
