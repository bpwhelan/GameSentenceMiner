# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GSM_Overlay is an Electron-based transparent overlay application for [GameSentenceMiner (GSM)](https://github.com/bpwhelan/GameSentenceMiner). It receives Japanese text and coordinate data via WebSocket from GSM and displays it both in a main textbox and as clickable on-screen character overlays positioned directly over the game window. The overlay integrates [Yomitan](https://github.com/yomidevs/yomitan) for Japanese dictionary lookups.

This is a fork/derivative of the [original transparent-texthooker-overlay](https://github.com/Saplling/transparent-texthooker-overlay) project but has diverged significantly and should NOT be merged back.

## Commands

### Development
```bash
npm start                    # Start the overlay in development mode with electron-forge
```

### Building
```bash
npm run package             # Package the app without creating installers
npm run make                # Create distributable installers for current platform
```

Note: No test suite is currently configured.

## Architecture Overview

### Application Structure

**Electron Multi-Process Architecture:**
- **Main Process** (`main.js`): Manages windows, IPC communication, WebSocket connections, settings, hotkeys, and system tray
- **Preload Script** (`preload.js`): Bridges main and renderer processes, exposes IPC and utility functions (wanakana, kuroshiro) to renderer
- **Renderer Process** (`index.html`): Main overlay UI displaying text boxes and character overlays
- **Settings Window** (`settings.html`): Configuration interface for overlay behavior, hotkeys, and integrations
- **Offset Helper** (`offset-helper.html`): Tool for calibrating overlay position on non-Windows platforms

### Key Components

#### WebSocket Communication
The overlay maintains **two WebSocket connections**:

1. **GSM Connection** (`ws://localhost:55002` by default)
   - Receives text and bounding box coordinates from GameSentenceMiner
   - Message format: `{data: [{text: string, bounding_rect: {...}, words: [{...}]}]}`
   - Text includes both sentence-level and word-level coordinate data

2. **Backend Connection** (`ws://localhost:55499` by default, via `backend_connector.js`)
   - Sends translation requests to Python backend
   - Receives translation results and errors
   - Handles focus restoration requests
   - Message types: `translation-result`, `translation-error`, `restore-focus-request`

#### Yomitan Integration
- Embedded Yomitan browser extension lives in `yomitan/` directory
- Loaded via `chrome-extension://` protocol with privileged permissions
- Modified to work in overlay context (see `yomitan_update_instructions.md` for patches)
- Settings accessible via hotkey (Alt+Shift+Y by default)
- Custom event dispatchers added: `yomitan-popup-shown`, `yomitan-popup-hidden`

#### Magpie Compatibility (Windows Only)
- Magpie is a window upscaling tool used with some games
- `magpie.js` and `magpie_compat.py` provide interop to detect Magpie scaling state
- Uses Python script via `python.exe` from GSM installation at `%APPDATA%/GameSentenceMiner/python_venv/Scripts/python.exe`
- Registers window message hooks to detect when Magpie starts/stops scaling
- Non-Windows platforms get no-op stubs

#### Japanese Text Processing
- **wanakana**: Kana/romaji conversion and character type detection
- **kuroshiro + kuromoji**: Furigana generation for kanji text
- Both exposed to renderer via IPC handles in preload script

#### Background Task Manager (`background.js`)
- Lightweight task scheduler for periodic background operations
- Single tick loop (default 250ms) checks all registered tasks
- Used for AFK timers, periodic state checks, etc.

### Settings and State Management

**Settings Storage:**
- User settings stored at `%APPDATA%/gsm_overlay/settings.json` (Windows) or `~/.config/gsm_overlay/settings.json` (macOS/Linux)
- GSM settings read from `%APPDATA%/GameSentenceMiner/config.json`
- Settings persist across sessions via `fs.writeFileSync` on change

**Default Settings Structure** (see `userSettings` object in `main.js`):
- Font size, WebSocket URLs, manual mode configuration
- Hotkeys for show/hide, translation, settings, furigana toggle, etc.
- Window state (pinned, hidden, position)

**Platform Differences:**
- Windows: Full feature set, `offsetX/offsetY` forced to 0 (uses Win32 coordinate mapping)
- macOS/Linux: `manualMode` forced to `true`, no Magpie, requires offset calibration

### IPC Communication Patterns

**Main → Renderer:**
- `text-data`: Send text and coordinates to display
- `translation-received`: Translation results from backend
- `magpie:scaling-changed`: Magpie state changed
- Various settings and state updates

**Renderer → Main:**
- `websocket-data`: Forward data received in renderer WebSocket
- `action-translate`: Request translation for current text
- `action-scan`: Trigger Yomitan scan
- `open-settings`, `open-yomitan-settings`: Open settings windows
- `update-window-shape`: Update click-through region for main overlay

### Window Management

**Main Overlay Window:**
- Transparent, always-on-top, frameless
- Click-through except on interactive elements (text boxes)
- Dynamic shape region updated based on text box positions (see `update-window-shape` handler)
- Can be hidden, minimized, or pinned via hotkeys

**Interactive Elements:**
- Elements with `.interactive` class trigger mouse event capture
- Preload script manages `set-ignore-mouse-events` IPC to toggle click-through
- Text boxes become visible with background on hover

## Development Guidelines

### Modifying Yomitan
When updating the embedded Yomitan extension, follow instructions in `yomitan_update_instructions.md`:
- Add custom event dispatchers for popup show/hide
- Disable `layoutAwareScan` by default (causes issues in overlay)
- Patch permissions-util.js with YomiNinja workaround
- Force `terminationCharacterMode` to "newlines" in text-scanner.js

### WebSocket Message Handling
- All GSM messages flow through `websocket-data` IPC event in main.js
- Backend connector automatically reconnects on disconnect (5s delay)
- Queue messages if connection not ready (flushed on connect)

### Adding Hotkeys
- Register in `userSettings` with Electron accelerator format (e.g., "Alt+Shift+T")
- Register with `globalShortcut.register()` in main process
- Add settings UI control in `settings.html`
- Save to settings.json on change

### Cross-Platform Considerations
- Check `process.platform` for platform-specific code paths
- Use `isWindows()`, `isLinux()`, `isMac()` helpers
- Gracefully degrade Windows-only features (Magpie) on other platforms
- Test manual mode thoroughly on macOS/Linux


#### Toolbox System

The Toolbox provides a modular overlay with utility tools. Key files:

- `toolbox/toolbox.js` - ToolboxManager class (visibility, layout, tool lifecycle)
- `toolbox/toolbox.css` - Overlay container styles
- `toolbox/tool-registry.js` - Tool catalog and dynamic loading
- `toolbox/tools/clock/` - 24-Hour Clock tool implementation
- `toolbox/tools/_template/` - Template for creating new tools

**Adding New Tools:**

1. Copy `toolbox/tools/_template/` to `toolbox/tools/your-tool/`
2. Implement the tool interface (init, destroy, onShow, onHide, updateSettings)
3. Register in `tool-registry.js` TOOL_MANIFEST
4. Add checkbox in `settings.html` toolbox section

**Settings Keys:**
- `toolboxEnabled` - Master toggle
- `toggleToolboxHotkey` - Hotkey (default: Alt+Shift+T)
- `enabledTools` - Array of enabled tool IDs
- `toolSettings` - Per-tool settings object

**IPC Channels:**
- `toggle-toolbox` - Main → Renderer: Toggle visibility
- `toolbox-visibility-changed` - Renderer → Main: Notify state change

## Important File Paths

- `main.js`: Electron main process, core application logic
- `index.html`: Main overlay UI and text rendering, HTML structure only
- `styles.css`: Stylesheet for overlay UI, text rendering
- `settings.html`: Settings window UI
- `preload.js`: Context bridge between main and renderer
- `backend_connector.js`: WebSocket client for Python backend
- `magpie.js`: Windows-only Magpie interop
- `yomitan/`: Embedded Yomitan extension (modified)
- `yomitan_update_instructions.md`: Patch instructions for Yomitan updates
- `forge.config.js`: Electron Forge build configuration

## Known Issues / Special Behaviors

- Yomitan `layoutAwareScan` causes weird behavior in overlay context - disabled by default
- Magpie detection requires GSM Python environment to be installed
- On non-Windows platforms, coordinate mapping requires manual offset calibration
- AFK timer automatically hides overlay after configured idle period
- Translation requests debounced/queued to avoid overwhelming backend  

