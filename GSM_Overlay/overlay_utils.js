class OverlayUtils {
  static hideYomitan() {
    try {
      // Create and dispatch a click event at (50, 50) to dismiss Yomitan
      // This spot is chosen because it's typically "safe" (empty) in the overlay
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: 50,
        clientY: 50,
      });
      
      // Dispatch on window/document to ensure it hits global listeners
      window.dispatchEvent(clickEvent);
      // Also try document.elementFromPoint to be more robust if needed, 
      // but dispatching to window is usually sufficient for global click handlers
      
      console.log('[OverlayUtils] Triggered click at (50,50) to hide Yomitan');
    } catch (error) {
      console.error('[OverlayUtils] Error hiding Yomitan:', error);
    }
  }
}

// Export for CommonJS (Node/Electron) and Browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OverlayUtils;
} else {
  window.OverlayUtils = OverlayUtils;
}
