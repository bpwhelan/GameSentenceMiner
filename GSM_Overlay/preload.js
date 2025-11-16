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
    
    // shape calculation & observer
    // Use a small padding in CSS pixels so clickable area slightly exceeds the box
    const PADDING_PX = 10;

    function sendWindowShape() {
        const mainBox = document.getElementById('main-box');
        if (!mainBox) return;
        const rect = mainBox.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;

        const shape = {
            x: Math.max(0, Math.floor((rect.x - PADDING_PX) * scale)),
            y: Math.max(0, Math.floor((rect.y - PADDING_PX) * scale)),
            width: Math.max(1, Math.ceil((rect.width + PADDING_PX * 2) * scale)),
            height: Math.max(1, Math.ceil((rect.height + PADDING_PX * 2) * scale))
        };

        ipcRenderer.send('update-window-shape', shape);
    }

    // Observe style/DOM changes and window resize to keep the main-window shape up-to-date
    const observer = new MutationObserver(() => sendWindowShape());
    const mainBox = document.getElementById('main-box');
    if (mainBox) {
        observer.observe(mainBox, {
            attributes: true,
            attributeFilter: ['style'],
            childList: true,
            subtree: true
        });

        window.addEventListener('resize', sendWindowShape);

        // Initial send
        sendWindowShape();
    }
});

// setInterval(() => {
//     setMouseEventHandlers();
// }, 250);