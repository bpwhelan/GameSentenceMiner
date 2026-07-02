(function () {
  var GLOBAL_KEY = '__jitenManatanCaretPatch';
  var CONTROL_EVENT = 'jiten:manatan-caret-patch-control';
  var OVERLAY_SELECTOR = '.jiten-manatan-overlay';

  var existing = window[GLOBAL_KEY];
  if (existing && typeof existing.install === 'function') {
    existing.install();
    return;
  }

  var state = {
    installed: false,
    originalCaretRangeFromPoint: null,
    originalCaretPositionFromPoint: null,
    controlHandler: null,
  };

  var isFunction = function (value) {
    return typeof value === 'function';
  };

  var closestOverlayFromNode = function (node) {
    if (!node) {
      return null;
    }

    var element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;

    if (!element || !element.closest) {
      return null;
    }

    return element.closest(OVERLAY_SELECTOR);
  };

  var closestOverlayFromPoint = function (x, y) {
    var element = document.elementFromPoint(x, y);

    if (!element || !element.closest) {
      return null;
    }

    return element.closest(OVERLAY_SELECTOR);
  };

  var withOverlayDisabled = function (overlay, callback) {
    if (!overlay) {
      return callback();
    }

    var previousDisplay = overlay.style.display;
    var previousPointerEvents = overlay.style.pointerEvents;

    overlay.style.display = 'none';
    overlay.style.pointerEvents = 'none';

    try {
      return callback();
    } finally {
      overlay.style.display = previousDisplay;
      overlay.style.pointerEvents = previousPointerEvents;
    }
  };

  var patchCaretRangeFromPoint = function () {
    if (!isFunction(document.caretRangeFromPoint)) {
      return;
    }

    state.originalCaretRangeFromPoint = document.caretRangeFromPoint.bind(document);

    document.caretRangeFromPoint = function (x, y) {
      var firstResult = state.originalCaretRangeFromPoint(x, y);

      if (!firstResult) {
        return firstResult;
      }

      var rangeOverlay = closestOverlayFromNode(firstResult.startContainer);
      var pointOverlay = closestOverlayFromPoint(x, y);
      var overlay = rangeOverlay || pointOverlay;

      if (!overlay) {
        return firstResult;
      }

      return withOverlayDisabled(overlay, function () {
        return state.originalCaretRangeFromPoint(x, y) || firstResult;
      });
    };
  };

  var patchCaretPositionFromPoint = function () {
    if (!isFunction(document.caretPositionFromPoint)) {
      return;
    }

    state.originalCaretPositionFromPoint = document.caretPositionFromPoint.bind(document);

    document.caretPositionFromPoint = function (x, y) {
      var firstResult = state.originalCaretPositionFromPoint(x, y);

      if (!firstResult) {
        return firstResult;
      }

      var positionOverlay = closestOverlayFromNode(firstResult.offsetNode);
      var pointOverlay = closestOverlayFromPoint(x, y);
      var overlay = positionOverlay || pointOverlay;

      if (!overlay) {
        return firstResult;
      }

      return withOverlayDisabled(overlay, function () {
        return state.originalCaretPositionFromPoint(x, y) || firstResult;
      });
    };
  };

  var unpatch = function () {
    if (!state.installed) {
      return;
    }

    if (state.originalCaretRangeFromPoint) {
      document.caretRangeFromPoint = state.originalCaretRangeFromPoint;
    }

    if (state.originalCaretPositionFromPoint) {
      document.caretPositionFromPoint = state.originalCaretPositionFromPoint;
    }

    state.originalCaretRangeFromPoint = null;
    state.originalCaretPositionFromPoint = null;
    state.installed = false;
  };

  var install = function () {
    if (state.installed) {
      return;
    }

    patchCaretRangeFromPoint();
    patchCaretPositionFromPoint();
    state.installed = true;
  };

  state.controlHandler = function (event) {
    var detail = event && event.detail ? event.detail : {};
    var action = detail.action;

    if (action === 'install') {
      install();
      return;
    }

    if (action === 'uninstall') {
      unpatch();
    }
  };

  window.addEventListener(CONTROL_EVENT, state.controlHandler);
  state.install = install;
  state.uninstall = unpatch;
  window[GLOBAL_KEY] = state;
  install();
})();
