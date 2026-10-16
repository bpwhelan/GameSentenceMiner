// All classic scripts share the existing settings bindings. Initialize only
// after their definitions and the complete control markup have loaded.
GSMSettingsHome.render();
initializeSettingBindings();
syncDisableInteractionSubOptionsUi();
updateControllerActivationFieldState();
updateTokenizerBackendFieldState();
initializeSettingsTabs();
renderOverlayPresetCards();
void applyPlatformSpecifics();
initializeSettingsInputs();
