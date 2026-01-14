# GSM Overlay - Toolbox System

The Toolbox provides a modular, transparent overlay with utility tools that assist users while playing games.

## Features

- **Transparent Full-Screen Overlay**: Tools are displayed on a transparent overlay that doesn't interfere with gameplay
- **Modular Tools**: Each tool is independent and can be enabled/disabled individually
- **Column-Based Layout**: Active tools are arranged in equal-width columns (100/N %)
- **Hotkey Toggle**: Quick toggle with Alt+Shift+T (configurable)
- **Independent from Main Box**: Toolbox remains visible when hiding main overlay (Alt+Shift+H)

## Available Tools

### 24-Hour Clock
Displays the current time in 24-hour format (HH:MM:SS), updating every second.

## Usage

### Enabling the Toolbox

1. Open GSM Overlay Settings (right-click tray icon → Settings)
2. Find the "Toolbox" section
3. Check "Enable Toolbox System"
4. Enable desired tools from the "Available Tools" list
5. Save settings

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Alt+Shift+T | Toggle toolbox visibility |
| Alt+Shift+H | Hide main overlay (toolbox stays visible) |

### Customizing the Hotkey

1. In Settings, find "Toggle Toolbox Hotkey"
2. Click the input field
3. Press your desired key combination
4. The new hotkey is saved automatically

## Developer Guide: Creating New Tools

### Quick Start

1. Copy the `toolbox/tools/_template` directory
2. Rename to your tool name (e.g., `timer`)
3. Rename files: `template.js` → `timer.js`, `template.css` → `timer.css`
4. Implement your tool
5. Register in `tool-registry.js`
6. Add checkbox in `settings.html`

### Tool Structure

```
toolbox/tools/my-tool/
├── my-tool.js    # Tool implementation
└── my-tool.css   # Tool styles
```

### Required Interface

```javascript
class MyTool {
  constructor(container) {
    this.container = container;
  }
  
  async init() { }        // Initialize tool, create DOM
  destroy() { }           // Clean up resources
  onShow() { }            // Called when toolbox shown
  onHide() { }            // Called when toolbox hidden
  updateSettings(s) { }   // Apply settings changes
}

// Factory function (required)
window.createMyTool = (container, settings) => new MyTool(container);
```

### Factory Function Naming

The factory function must be named: `window.create{PascalCaseId}Tool`

| Tool ID | Factory Function |
|---------|------------------|
| clock | createClockTool |
| my-timer | createMyTimerTool |
| word_counter | createWordCounterTool |

### Registering Your Tool

Add to `tool-registry.js`:

```javascript
const TOOL_MANIFEST = {
  // ... existing tools
  'my-tool': {
    id: 'my-tool',
    name: 'My Tool Name',
    path: './tools/my-tool/my-tool.js',
    cssPath: './tools/my-tool/my-tool.css',
    hasSettings: false,
    enabled: false
  }
};
```

Add checkbox to `settings.html` in the toolbox section:

```html
<label>
  <span class="label-text">
    My Tool Name
    <div class="hotkey-info">Description of what it does</div>
  </span>
  <input type="checkbox" class="tool-checkbox" data-tool-id="my-tool" />
</label>
```

### Best Practices

1. **Transparent Background**: Use `background: transparent`
2. **Text Readability**: Use text-shadow for visibility on any background
3. **Clean Cleanup**: Always clear intervals/timeouts in destroy()
4. **No Dependencies**: Use vanilla JavaScript only
5. **Self-Contained**: Keep all logic within your tool
6. **Responsive**: Support varying column widths
7. **Performance**: Minimize resource usage

### Styling Guidelines

```css
.my-tool-display {
  color: #ffffff;
  text-shadow: 
    0 0 10px rgba(0, 0, 0, 0.8),
    2px 2px 4px rgba(0, 0, 0, 0.9);
  background: transparent;
  user-select: none;
}
```

## Architecture

```
toolbox/
├── toolbox.js           # ToolboxManager - visibility, layout, tool lifecycle
├── toolbox.css          # Overlay container styles
├── tool-registry.js     # Tool catalog and dynamic loading
└── tools/
    ├── clock/           # 24-Hour Clock tool
    │   ├── clock.js
    │   └── clock.css
    └── _template/       # Template for new tools
        ├── template.js
        └── template.css
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| toolboxEnabled | false | Master toggle for toolbox |
| toggleToolboxHotkey | Alt+Shift+T | Hotkey to show/hide |
| enabledTools | [] | Array of enabled tool IDs |

## Troubleshooting

### Toolbox not appearing
- Check "Enable Toolbox System" is checked
- Ensure at least one tool is enabled
- Try pressing the hotkey (default: Alt+Shift+T)

### Clock not updating
- Disable and re-enable the clock tool
- Restart the application

### Hotkey not working
- Check for conflicts with other applications
- Try a different key combination
- Avoid using plain Ctrl (may conflict with copy/paste)

## Version History

- **1.0.0** - Initial release with Clock tool

  1. Settings Structure: The GameSentenceMiner overlay has a settings.html file   organized into multiple setting groups. There's a Toolbox section that manages   various utility tools (clock, notepad, pomodoro).                            
  2. Tool Settings Pattern: Tool-specific settings (like pomodoro's duration  
  settings) should be nested within the Toolbox settings group, not in separate 
  sections. This keeps related settings together contextually.
  3. Dynamic UI: JavaScript controls visibility of tool settings panels - they  
  show/hide based on whether the tool's checkbox is enabled (handled by
  updateToolSettingsPanels() function).
  4. Visual Design Pattern: Toolbox tools use a consistent semi-transparent dark
   background style:
    - Background: rgba(30, 30, 35, 0.75-0.80)
    - Border: 1px solid rgba(255, 255, 255, 0.15)
    - Border radius: 8px

  This creates visual cohesion across tools like notepad and pomodoro while     
  maintaining overlay transparency.
  5. Tool Architecture: Each tool (notepad, pomodoro) has its own subdirectory
  with separate CSS and JS files, making them modular and independently
  styleable.
  6. Panel Sizing Consistency: Tools should use consistent sizing patterns to
  maintain visual balance. The Goals panel was updated (Jan 2026) to match the
  Pomodoro panel dimensions:
    - Width/Height: 100% (full container instead of max-width constraints)
    - Padding: 20px (increased from 12px)
    - Font sizes increased across all elements:
      * Headers: 18px (from 13px)
      * Icons: 20px (from 14px)
      * Percentages: 16px (from 12px)
      * Progress values: 14px (from 11px)
      * Loading/error states: 18px (from 14px)
    This ensures all panels have comparable visual weight and readability in
    the overlay environment.