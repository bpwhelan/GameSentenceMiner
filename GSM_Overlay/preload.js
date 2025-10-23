const { ipcRenderer } = require('electron');

// https://stackoverflow.com/questions/74464771/how-to-implement-click-through-window-except-on-element-in-electron
let isMouseOverInteractiveElement = false;

function setMouseEventHandlers() {
    const interactiveElements = document.querySelectorAll('.interactive');

    interactiveElements.forEach((element) => {
        element.addEventListener('mouseenter', () => {
            isMouseOverInteractiveElement = true;
            ipcRenderer.send('set-ignore-mouse-events', false);
        });
        if (!element.classList.contains("half-interactive")) {
            element.addEventListener('mouseleave', () => {
                isMouseOverInteractiveElement = false;
                ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
            });
        }
    });
}

// Expose ipcRenderer to the renderer process through context bridge
window.addEventListener('DOMContentLoaded', () => {
    setMouseEventHandlers();
    
    // Make ipcRenderer available globally for the app
    window.ipcRenderer = ipcRenderer;
});

// setInterval(() => {
//     setMouseEventHandlers();
// }, 250);