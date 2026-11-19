(() => {
  const dispatch = window.__GSM_DESKTOP_DISPATCH__;
  window.__gsmClickthroughNativeSamples = 0;
  // The real mouse can enter/leave WebView when passthrough changes. Detach
  // DOM listeners for this final fixture; exercise the production controller's
  // forwarded path and native IPC without mixing two independent cursors.
  textHover.dispose();
  textHover.reset();
  // Keep the test independent of physical mouse movement without moving it.
  window.__GSM_DESKTOP_DISPATCH__ = (channel, args) => {
    if (channel === 'text-hover-pointer') window.__gsmClickthroughNativeSamples++;
    else dispatch(channel, args);
  };
  const text = document.createElement('div');
  text.className = 'text-box';
  text.style.cssText = 'position:fixed!important;left:20px;top:20px;width:100px;height:60px;pointer-events:auto;z-index:2147483647;visibility:visible!important;';
  const popup = document.createElement('iframe');
  popup.className = 'yomitan-popup';
  popup.style.cssText = 'position:fixed!important;left:180px;top:20px;width:100px;height:60px;pointer-events:auto;z-index:2147483647;visibility:visible!important;';
  document.body.append(text, popup);
  window.__gsmClickthrough = {
    point(target, buttons = 0) {
      const expected = target === 'text' ? text : popup;
      const hit = document.elementFromPoint(target === 'text' ? 40 : 200, 40);
      if (hit !== expected) throw Error(`Clickthrough fixture hit ${hit?.tagName}.${hit?.className} instead of ${target}`);
      dispatch('text-hover-pointer', [{ x: target === 'text' ? 40 : 200, y: 40, buttons }]);
      return true;
    },
    cleanup() {
      if (!window.__gsmClickthroughNativeSamples) throw Error('Native pointer forwarding never reached the overlay');
      text.remove(); popup.remove();
      window.__GSM_DESKTOP_DISPATCH__ = dispatch;
      dispatch('overlay-input-reset', []);
    },
  };
  return true;
})()
