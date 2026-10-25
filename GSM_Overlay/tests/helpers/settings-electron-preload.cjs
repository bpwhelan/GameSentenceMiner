// Keep the isolated settings fixture away from a running GSM input server.
window.WebSocket = class {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 3;
  close() {}
  send() {}
};
window.addEventListener("error", (event) => {
  require("electron").ipcRenderer.send("settings-test-error", event.error?.stack || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  require("electron").ipcRenderer.send("settings-test-error", String(event.reason?.stack || event.reason));
});
