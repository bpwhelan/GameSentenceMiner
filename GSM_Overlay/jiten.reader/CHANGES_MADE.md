# Changes Made to Jiten Reader Extension

To ensure a seamless integration with the GSM Overlay and prevent unwanted UI elements, the following changes have been made to the Jiten Reader extension.

## 1. Hide "Parse" Button

The "Parse" button that appears on pages has been forcibly hidden.

### File: `views/settings.html`
- **Action**: Commented out the `showParseButton` checkbox to remove it from the settings UI.
- **Location**: Around line 311 (search for `showParseButton`).
- **Code Change**:
  ```html
  <!-- Added style="display: none;" to the checkbox container -->
  <div class="checkbox" style="display: none;">
      <input type="checkbox" id="showParseButton" name="showParseButton" />
      <label for="showParseButton">
        Show a small parse page button at the bottom right of manually parsed pages
      </label>
  </div>
  ```

### File: `js/ajb.js`
- **Action 1**: Changed default configuration of `showParseButton` to `false` (though this is redundant with the forced removal below, it's good practice).
  - **Location**: Around line 95.
  - **Code Change**: `showParseButton: false,` (was `true`)

- **Action 2**: Prevented the Parse Button from being added to the DOM.
  - **Location**: In `installParseButton()` method (around line 4348).
  - **Code Change**: Commented out the appendChild line.
  ```javascript
  // document.body.appendChild(this._buttonRoot);
  ```

### File: `js/background-worker.js`
- **Action**: Changed default configuration of `showParseButton` to `false`.
  - **Location**: Around line 95.
  - **Code Change**: `showParseButton: false,` (was `true`)

## 2. Extension Configuration (GSM_Overlay/main.js)
The extension is now conditionally loaded based on user settings in the overlay.
- `enableJitenReader` setting added to `userSettings`.
- `loadExtension` is called dynamically when the setting is enabled.
- Extension is removed from session when disabled.

These changes ensure the "Parse" button never appears, regardless of the internal state or previous configuration of the extension.
