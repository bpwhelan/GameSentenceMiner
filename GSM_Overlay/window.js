const { windowManager } = require("node-window-manager");
const path = require("path");

// --- Target Information from the OBS String ---
const TARGET_TITLE = "機神咆吼デモンベイン　ver1.00";
// Note: Window Class is not easily accessible via this library.
// const TARGET_CLASS = "機神咆吼デモンベイン"; 
const TARGET_EXECUTABLE = "Demonbane.exe";

function findWindow() {
    // getWindows() returns a list of all active windows
    const windows = windowManager.getWindows();
    
    for (const window of windows) {
        // 1. Check Executable Name
        const exeName = path.basename(window.path);
        
        // Use a case-insensitive check for the executable
        if (exeName.toLowerCase() !== TARGET_EXECUTABLE.toLowerCase()) {
            continue;
        }

        // 2. Check Window Title
        const windowTitle = window.getTitle();
        if (windowTitle !== TARGET_TITLE) {
            continue;
        }

        // If we get here, both executable and title match!
        return window; // Return the entire window object
    }

    return null; // Return null if not found
}

function isWindowFocused(window) {
    const activeWindow = windowManager.getActiveWindow();
    return activeWindow && activeWindow.id === window.id;
}

function isWindowVisible(window) {
    return window.isVisible ? window.isVisible() : false;
}

function isWindowFullScreen(window) {
    if (!window) return false;

    const bounds = window.getBounds();
    const displays = windowManager.getDisplays();

    for (const display of displays) {
        if (display.bounds.contains(bounds)) {
            return display.bounds.width === bounds.width && display.bounds.height === bounds.height;
        }
    }

    return false;
}

// --- Running the function ---
const foundWindow = findWindow();

    if (foundWindow) {
    // The handle is stored in the 'id' property, which is a Buffer.
    // We can convert it to a number for display.
    setInterval(() => {
        const currentWindow = findWindow();
        if (currentWindow) {
            const handle = currentWindow.id; // The 'id' property is the HWND

            console.log("Success! Window found.");
            console.log(`  - Handle (HWND): ${handle}`);
            console.log(`  - Title: ${currentWindow.getTitle()}`);
            console.log(`  - Path: ${currentWindow.path}`);
            console.log(`  - Is Focused: ${isWindowFocused(currentWindow)}`);
            console.log(`  - Is Visible: ${isWindowVisible(currentWindow)}`);
        } else {
            console.log("Window not found.");
        }
    }, 1000);
} else {
    console.log("Failed to find the specified window. Make sure the application is running and the title/exe are correct.");
}