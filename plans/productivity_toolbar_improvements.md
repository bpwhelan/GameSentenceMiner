# Productivity Toolbar Improvements Plan

## Overview
Improvements to the productivity toolbar feature based on commit `b50046bb64ff576968457d6e3bcbf6e9908afa39`, addressing layout, code quality, and feature enhancements.

---

## 1. Settings UI Reorganization

### 1.1 Move Toolbar Hotkey to Hotkeys Section
**File**: [`GSM_Overlay/settings.html`](GSM_Overlay/settings.html)

**Current Location**: Lines 556-610 (Productivity Toolbar section)  
**Target Location**: Lines 472-554 (Hotkeys section)

**Changes**:
- Remove the toolbar hotkey input from the "Productivity Toolbar" section (lines 559-574)
- Add it to the existing "Hotkeys" section after "Overlay Settings Hotkey"
- Keep the same structure with hotkey input, guide button, and Ctrl warning
- Update initialization call in JavaScript section (line 835-840)

**Rationale**: Keeps all hotkeys in one logical section for better UX

---

### 1.2 Reorganize Productivity Toolbar Section to Single Column
**File**: [`GSM_Overlay/settings.html`](GSM_Overlay/settings.html)

**Current State**: Lines 556-610 in a `settings-grid` (2-column responsive layout)

**Target State**: Single vertical column layout

**Changes**:
```html
<!-- Change from: -->
<div class="settings-grid">
  <div class="setting-group">
    <h4>Productivity Toolbar</h4>
    <!-- settings -->
  </div>
</div>

<!-- To: -->
<div class="settings-grid single-column">
  <div class="setting-group">
    <h4>Productivity Toolbar</h4>
    <!-- settings (without hotkey) -->
  </div>
</div>
```

**Settings to Keep** (vertical order):
1. Enabled Tools (checkboxes)
2. Pomodoro Work Duration
3. Pomodoro Break Duration
4. Pomodoro Sound Notifications

---

## 2. Code Quality Improvements

### 2.1 Extract Duplicated enabledTools Logic
**File**: [`GSM_Overlay/settings.html`](GSM_Overlay/settings.html:843)

**Problem**: Lines 843-855 have duplicated code for building enabledTools array

**Current Code**:
```javascript
document.getElementById("enableNotepad").addEventListener("change", (event) => {
  const enabledTools = [];
  if (document.getElementById("enableNotepad").checked) enabledTools.push("notepad");
  if (document.getElementById("enablePomodoro").checked) enabledTools.push("pomodoro");
  handleSettingChange("enabledTools", enabledTools);
});

document.getElementById("enablePomodoro").addEventListener("change", (event) => {
  const enabledTools = [];
  if (document.getElementById("enableNotepad").checked) enabledTools.push("notepad");
  if (document.getElementById("enablePomodoro").checked) enabledTools.push("pomodoro");
  handleSettingChange("enabledTools", enabledTools);
});
```

**Solution**:
```javascript
// Shared function to build enabled tools array
function updateEnabledTools() {
  const enabledTools = [];
  if (document.getElementById("enableNotepad").checked) enabledTools.push("notepad");
  if (document.getElementById("enablePomodoro").checked) enabledTools.push("pomodoro");
  handleSettingChange("enabledTools", enabledTools);
}

// Use shared function in event listeners
document.getElementById("enableNotepad").addEventListener("change", updateEnabledTools);
document.getElementById("enablePomodoro").addEventListener("change", updateEnabledTools);
```

**Location**: After existing helper functions (around line 877)

---

### 2.2 Extract Base64 Audio to Named Constant
**File**: [`GSM_Overlay/index.html`](GSM_Overlay/index.html:2722)

**Problem**: Hardcoded base64 audio data makes code difficult to maintain (line 2722)

**Current Code**:
```javascript
function playNotification() {
  if (toolbarSettings.pomodoroSoundEnabled) {
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGH0fPTgjMGHm7A7+OZURE=');
    audio.play().catch(() => {});
  }
  // ...
}
```

**Solution**:
```javascript
// At top of pomodoro tool registration (around line 2657)
const NOTIFICATION_SOUND_DATA = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGH0fPTgjMGHm7A7+OZURE=';

// In playNotification function
function playNotification() {
  if (toolbarSettings.pomodoroSoundEnabled) {
    const audio = new Audio(NOTIFICATION_SOUND_DATA);
    audio.play().catch(() => {});
  }
  // ...
}
```

**Location**: Inside the [`registerTool('pomodoro', { ... })`](GSM_Overlay/index.html:2661) block

---

### 2.3 Add Constant for Focus Delay
**File**: [`GSM_Overlay/index.html`](GSM_Overlay/index.html:2649)

**Problem**: Magic number 100 (milliseconds) lacks explanation (line 2649)

**Current Code**:
```javascript
// Focus on load
setTimeout(() => textarea.focus(), 100);
```

**Solution**:
```javascript
// At top of notepad tool registration (around line 2620)
const NOTEPAD_FOCUS_DELAY_MS = 100; // Delay to ensure textarea is rendered and ready

// In init function
// Focus on load after a short delay to ensure the textarea is rendered and ready
setTimeout(() => textarea.focus(), NOTEPAD_FOCUS_DELAY_MS);
```

**Location**: Inside the [`registerTool('notepad', { ... })`](GSM_Overlay/index.html:2622) block

---

## 3. Tools Display Improvements

### 3.1 Update Tools Grid Layout
**File**: [`GSM_Overlay/index.html`](GSM_Overlay/index.html:547)

**Current CSS** (lines 547-552):
```css
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  padding: 16px;
}
```

**Problems**:
- `auto-fit` fills vertically first
- Tools are small (min 300px)
- Doesn't take up majority of screen

**New CSS**:
```css
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(500px, 1fr));
  grid-auto-flow: row; /* Fill horizontally first */
  gap: 24px;
  padding: 24px;
  max-height: 80vh; /* Take up majority of screen */
  overflow-y: auto; /* Scroll if too many tools */
}
```

**Changes**:
- Use `auto-fill` instead of `auto-fit` for better horizontal filling
- Increase minimum size from 300px → 500px
- Add explicit `grid-auto-flow: row` (horizontal-first)
- Add `max-height: 80vh` to use majority of screen
- Increase gap from 16px → 24px for better spacing
- Add overflow scrolling for many tools

---

### 3.2 Increase Tool Module Sizes
**File**: [`GSM_Overlay/index.html`](GSM_Overlay/index.html:554)

**Current CSS** (lines 554-562):
```css
.tool-module {
  background: rgba(30, 30, 30, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 16px;
  min-height: 200px;
  display: flex;
  flex-direction: column;
}
```

**New CSS**:
```css
.tool-module {
  background: rgba(30, 30, 30, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 24px;
  min-height: 350px; /* Increased from 200px */
  display: flex;
  flex-direction: column;
}
```

**Changes**:
- Increase `min-height` from 200px → 350px
- Increase `padding` from 16px → 24px
- Increase `border-radius` from 6px → 8px

---

### 3.3 Update Toolbar Container
**File**: [`GSM_Overlay/index.html`](GSM_Overlay/index.html:495)

**Current CSS** (lines 495-510):
```css
.productivity-toolbar {
  position: fixed;
  top: 50px;
  left: 50%;
  transform: translateX(-50%);
  min-width: 600px;
  max-width: 90vw;
  background: rgba(20, 20, 20, 0.85);
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  z-index: 10000;
  color: white;
  font-family: -apple-system, sans-serif;
  backdrop-filter: blur(10px);
}
```

**New CSS**:
```css
.productivity-toolbar {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%); /* Center both axes */
  min-width: 800px; /* Increased from 600px */
  max-width: 95vw; /* Increased from 90vw */
  max-height: 90vh; /* Add max height */
  background: rgba(20, 20, 20, 0.93); /* Slightly more opaque */
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-radius: 12px; /* Increased from 8px */
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6); /* Larger shadow */
  z-index: 10000;
  color: white;
  font-family: -apple-system, sans-serif;
  backdrop-filter: blur(15px); /* Increased blur */
  display: flex;
  flex-direction: column; /* Add flex for proper scrolling */
}
```

**Changes**:
- Center vertically with `top: 50%` and `translate(-50%, -50%)`
- Increase `min-width` from 600px → 800px
- Increase `max-width` from 90vw → 95vw
- Add `max-height: 90vh` to ensure tools are visible
- Make slightly more opaque (0.85 → 0.93)
- Increase `border-radius` and shadow size
- Add flex display for proper scrolling layout

---

## 4. Add/Remove Tools Feature

### 4.1 Update Settings UI
**File**: [`GSM_Overlay/settings.html`](GSM_Overlay/settings.html:575)

**Current UI** (lines 575-590):
```html
<label>
  <span class="label-text">
    Enabled Tools
    <div class="hotkey-info">Select which tools appear in the toolbar</div>
  </span>
  <div style="display: flex; flex-direction: column; gap: 8px;">
    <label style="display: flex; align-items: center; gap: 8px;">
      <input type="checkbox" id="enableNotepad" checked />
      <span>📝 Notepad</span>
    </label>
    <label style="display: flex; align-items: center; gap: 8px;">
      <input type="checkbox" id="enablePomodoro" checked />
      <span>🍅 Pomodoro Timer</span>
    </label>
  </div>
</label>
```

**New UI Design**:
```html
<label>
  <span class="label-text">
    Enabled Tools
    <div class="hotkey-info">Toggle tools to show/hide in the toolbar</div>
  </span>
  <div id="tools-list" style="display: flex; flex-direction: column; gap: 8px;">
    <!-- Dynamically generated from TOOL_REGISTRY -->
  </div>
</label>
```

**JavaScript to Generate**:
```javascript
// In preload-settings handler (around line 1107)
function updateToolsList() {
  const container = document.getElementById('tools-list');
  container.innerHTML = '';
  
  // Define available tools with metadata
  const availableTools = [
    { id: 'notepad', name: '📝 Notepad', description: 'Quick notes during gameplay' },
    { id: 'pomodoro', name: '🍅 Pomodoro Timer', description: 'Focus timer with breaks' }
  ];
  
  availableTools.forEach(tool => {
    const isEnabled = enabledTools.includes(tool.id);
    const toolElement = document.createElement('label');
    toolElement.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 8px; background: rgba(255,255,255,0.02); border-radius: 4px;';
    toolElement.innerHTML = `
      <input type="checkbox" id="enable${tool.id.charAt(0).toUpperCase() + tool.id.slice(1)}" 
             ${isEnabled ? 'checked' : ''} 
             data-tool-id="${tool.id}" />
      <div style="flex: 1;">
        <div style="font-weight: 500;">${tool.name}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.5);">${tool.description}</div>
      </div>
    `;
    container.appendChild(toolElement);
  });
  
  // Add event listeners
  container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', updateEnabledTools);
  });
}
```

---

### 4.2 Dynamic Tool Management
**File**: [`GSM_Overlay/settings.html`](GSM_Overlay/settings.html)

**New Function**:
```javascript
// Updated updateEnabledTools function (replaces duplicated code)
function updateEnabledTools() {
  const enabledTools = [];
  document.querySelectorAll('#tools-list input[type="checkbox"]').forEach(checkbox => {
    if (checkbox.checked) {
      enabledTools.push(checkbox.dataset.toolId);
    }
  });
  handleSettingChange("enabledTools", enabledTools);
}
```

**Benefits**:
- Automatically scales with new tools
- No hardcoded tool IDs in event listeners
- Single source of truth for tools list
- Easy to add new tools in the future

---

### 4.3 Future Extensibility
To add a new tool in the future:

1. **Register tool in [`index.html`](GSM_Overlay/index.html)**:
```javascript
registerTool('mytool', {
  render: () => '...',
  init: (element) => { ... },
  cleanup: () => { ... }
});
```

2. **Add to availableTools in [`settings.html`](GSM_Overlay/settings.html)**:
```javascript
const availableTools = [
  { id: 'notepad', name: '📝 Notepad', description: 'Quick notes during gameplay' },
  { id: 'pomodoro', name: '🍅 Pomodoro Timer', description: 'Focus timer with breaks' },
  { id: 'mytool', name: '🎯 My Tool', description: 'Description here' }
];
```

That's it! The UI will automatically show the checkbox.

---

## 5. Implementation Checklist

### Phase 1: Code Quality (Low Risk)
- [ ] Extract `NOTIFICATION_SOUND_DATA` constant in [`index.html`](GSM_Overlay/index.html:2722)
- [ ] Extract `NOTEPAD_FOCUS_DELAY_MS` constant in [`index.html`](GSM_Overlay/index.html:2649)
- [ ] Create `updateEnabledTools()` function in [`settings.html`](GSM_Overlay/settings.html:843)
- [ ] Update event listeners to use shared function

### Phase 2: Settings Layout (Medium Risk)
- [ ] Move toolbar hotkey to Hotkeys section in [`settings.html`](GSM_Overlay/settings.html:559)
- [ ] Update Productivity Toolbar section to `single-column` class
- [ ] Verify hotkey initialization still works
- [ ] Test settings save/load

### Phase 3: Tools Display (Medium Risk)
- [ ] Update `.tools-grid` CSS in [`index.html`](GSM_Overlay/index.html:547)
- [ ] Update `.tool-module` CSS in [`index.html`](GSM_Overlay/index.html:554)
- [ ] Update `.productivity-toolbar` CSS in [`index.html`](GSM_Overlay/index.html:495)
- [ ] Test toolbar with 1, 2, and 3+ tools
- [ ] Verify horizontal-first layout
- [ ] Test responsive behavior

### Phase 4: Dynamic Tool Management (High Risk - New Feature)
- [ ] Create `updateToolsList()` function in [`settings.html`](GSM_Overlay/settings.html)
- [ ] Replace static checkboxes with dynamic generation
- [ ] Update `updateEnabledTools()` to work with dynamic list
- [ ] Test enabling/disabling tools
- [ ] Verify tools persist across sessions
- [ ] Test with all tools disabled (edge case)

---

## 6. Testing Plan

### Manual Testing
1. **Settings UI**
   - [ ] Open settings, verify toolbar hotkey in Hotkeys section
   - [ ] Verify Productivity Toolbar section is single column
   - [ ] Toggle each tool on/off, verify changes persist
   - [ ] Change hotkey, verify it updates

2. **Toolbar Display**
   - [ ] Open toolbar with all tools enabled
   - [ ] Verify tools appear in horizontal grid
   - [ ] Verify tools are large and take up majority of screen
   - [ ] Test with 1 tool only, verify layout
   - [ ] Test with 2 tools, verify horizontal arrangement

3. **Tool Functionality**
   - [ ] Notepad: Type notes, verify they persist
   - [ ] Pomodoro: Start timer, verify it works
   - [ ] Pomodoro: Complete session, verify notification plays
   - [ ] Disable tool in settings, verify it doesn't appear

### Edge Cases
- [ ] All tools disabled (toolbar should show empty message)
- [ ] Very small screen (tools should scroll)
- [ ] Very large screen (tools should expand)
- [ ] Rapid enable/disable of tools
- [ ] Settings changes while toolbar is open

---

## 7. Files Modified Summary

| File | Lines Changed | Type |
|------|---------------|------|
| [`GSM_Overlay/settings.html`](GSM_Overlay/settings.html) | ~100 | Refactor + Feature |
| [`GSM_Overlay/index.html`](GSM_Overlay/index.html) | ~50 | Refactor + CSS |
| [`GSM_Overlay/main.js`](GSM_Overlay/main.js) | 0 | No changes needed |

**Total Estimated Changes**: ~150 lines across 2 files

---

## 8. Potential Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing tool checkboxes | High | Keep backward compatibility in settings loader |
| Layout breaks on small screens | Medium | Add media queries for mobile/small displays |
| Tools list gets too long | Low | Add scrolling to tools-list container |
| Settings don't persist | High | Thorough testing of save/load cycle |
| CSS conflicts with existing styles | Low | Use specific class names, test thoroughly |

---

## 9. Future Enhancements

### Potential New Tools
- **Calculator**: Basic calculator for quick math
- **Dictionary**: Quick word lookup (integrate with Yomitan)
- **Bookmarks**: Save important game moments/text
- **Stats Tracker**: Track study time/cards reviewed
- **Audio Recorder**: Record pronunciation practice

### UI Improvements
- Drag-and-drop to reorder tools
- Tool presets (e.g., "Study Mode", "Gaming Mode")
- Tool-specific settings button
- Collapsible sections for many tools
- Search/filter tools list

---

## 10. Conclusion

These improvements will:
1. ✅ Clean up code duplication and magic numbers
2. ✅ Improve settings organization and UX
3. ✅ Make tools more prominent and easier to use
4. ✅ Enable easy addition of new tools in the future
5. ✅ Maintain backward compatibility with existing settings

The changes are well-scoped, testable, and provide a solid foundation for the productivity toolbar feature.
