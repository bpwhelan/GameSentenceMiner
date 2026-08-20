const { ipcRenderer } = require('electron');
const xwaylandOverlayFeaturesEnabled = process.platform === 'linux' &&
    process.env.GSM_OVERLAY_XWAYLAND_FEATURES_ACTIVE === '1';
const overlayShape = xwaylandOverlayFeaturesEnabled ? require('./overlay_shape') : null;

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

    if (!xwaylandOverlayFeaturesEnabled) return;
    const { INTERACTIVE_ELEMENT_SELECTOR, buildShapeRects } = overlayShape;

    // Interactive hit-test regions use DIP coordinates, which match renderer
    // CSS pixels at the default page zoom.
    const PADDING_PX = Number(process.env.GSM_OVERLAY_SHAPE_PADDING || 24);
    const SHAPE_DEBOUNCE_MS = 50;
    let shapeUpdateFrame = null;
    let shapeUpdateTimer = null;
    let lastShapeSignature = null;

    function sendWindowShape() {
        shapeUpdateFrame = null;
        const rects = [];
        document.querySelectorAll(INTERACTIVE_ELEMENT_SELECTOR).forEach((element) => {
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
                return;
            }
            rects.push(...element.getClientRects());
        });

        const shapes = buildShapeRects(rects, {
            padding: PADDING_PX,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
        });
        const signature = JSON.stringify(shapes);
        if (signature === lastShapeSignature) return;
        lastShapeSignature = signature;
        ipcRenderer.send('update-window-shape', shapes);
    }

    function scheduleWindowShape() {
        if (shapeUpdateTimer === null && shapeUpdateFrame === null) {
            shapeUpdateFrame = window.requestAnimationFrame(sendWindowShape);
        }
        if (shapeUpdateTimer !== null) {
            window.clearTimeout(shapeUpdateTimer);
        }
        shapeUpdateTimer = window.setTimeout(() => {
            shapeUpdateTimer = null;
            if (shapeUpdateFrame === null) {
                shapeUpdateFrame = window.requestAnimationFrame(sendWindowShape);
            }
        }, SHAPE_DEBOUNCE_MS);
    }

    // Interactive OCR boxes and Yomitan frames are created dynamically outside
    // #main-box, so observe the full overlay DOM and coalesce mutation bursts.
    const observer = new MutationObserver(scheduleWindowShape);
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'disabled'],
        childList: true,
        characterData: true,
        subtree: true
    });

    window.addEventListener('resize', scheduleWindowShape);
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(scheduleWindowShape);
    }
    scheduleWindowShape();
});

// setInterval(() => {
//     setMouseEventHandlers();
// }, 250);
