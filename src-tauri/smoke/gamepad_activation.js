(async () => {
  const until = async (condition, message) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error(message);
  };
  await until(() => manualMode && gamepadHandler && !manualHotkeyPressed
    && gamepadHandler.config.autoConfirmSelection === false,
  'Controller settings were not delivered');

  await handleOverlayWebSocketData(JSON.stringify({
    type: 'word_coordinates', line_id: 'controller-activation-smoke',
    data: [{ text: '女神の祝福',
      bounding_rect: { x1: 0.25, y1: 0.4, x3: 0.5, y3: 0.46 },
      words: [{ text: '女神の祝福',
        bounding_rect: { x1: 0.25, y1: 0.4, x3: 0.5, y3: 0.46 } }],
    }],
  }));
  const visibleText = () => [...document.querySelectorAll('.text-box')]
    .some(box => box.getClientRects().length > 0);
  if (visibleText()) throw Error('Manual overlay should start hidden');

  // Drive the production handler -> host -> reveal path. No manual-hotkey
  // message or synthetic renderer reveal is supplied by this test.
  for (let entry = 0; entry < 2; entry++) {
    gamepadHandler.activateNavigation({ type: 'keyboard' });
    await until(() => manualHotkeyPressed && visibleText()
      && gamepadHandler.isActive && !gamepadHandler.pendingNavigationActivation,
    'Navigation activation did not reveal and select overlay text');
    gamepadHandler.deactivateNavigation();
    await until(() => !manualHotkeyPressed && !visibleText()
      && !gamepadHandler.isActive,
    'Navigation exit did not release the manual overlay');
  }
  return true;
})()
