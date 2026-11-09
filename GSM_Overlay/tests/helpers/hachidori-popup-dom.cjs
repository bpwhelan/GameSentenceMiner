// Test-only inspection through Chromium's debugger. Keep upstream's closed
// popup root intact, then expose its actual DOM to renderer assertions.
async function exposeHachidoriPopupRoot(contents) {
  if (await contents.executeJavaScript(`Boolean(document.querySelector('hachidori-host')?.shadowRoot)`)) return true;
  const debuggerApi = contents.debugger;
  const attached = debuggerApi.isAttached();
  if (!attached) debuggerApi.attach('1.3');
  try {
    const { root } = await debuggerApi.sendCommand('DOM.getDocument');
    const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId, selector: 'hachidori-host',
    });
    if (!nodeId) return false;
    const { node } = await debuggerApi.sendCommand('DOM.describeNode', { nodeId });
    const popupRoot = node.shadowRoots?.[0];
    if (!popupRoot) return false;
    const { object } = await debuggerApi.sendCommand('DOM.resolveNode', {
      backendNodeId: popupRoot.backendNodeId,
    });
    try {
      const result = await debuggerApi.sendCommand('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () {
          Object.defineProperty(this.host, 'shadowRoot', { configurable: true, get: () => this });
        }`,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    } finally {
      await debuggerApi.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
    }
    return true;
  } finally {
    if (!attached) debuggerApi.detach();
  }
}

module.exports = { exposeHachidoriPopupRoot };
