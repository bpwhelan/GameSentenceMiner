// Both standalone and hosted overlays use the backend's shared model selector.
function createVitaModelRequest(getPort, fetchImpl = fetch) {
  return async (request = {}) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        (request.model !== undefined && !['small', 'normal', 'large'].includes(request.model))) {
      throw new Error('Invalid VOCR model size');
    }
    const changing = request.model !== undefined;
    const response = await fetchImpl(`http://127.0.0.1:${getPort()}/api/ocr/vita-model`, {
      method: changing ? 'POST' : 'GET',
      headers: changing ? { 'Content-Type': 'application/json' } : undefined,
      body: changing ? JSON.stringify({ model: request.model }) : undefined,
      signal: AbortSignal.timeout(changing ? 300000 : 5000),
    });
    if (!response.ok) throw new Error(`Could not reach VOCR settings (HTTP ${response.status})`);
    const status = await response.json();
    if (!status || !['small', 'normal', 'large'].includes(status.model)) throw new Error('Invalid VOCR model status');
    return status;
  };
}

module.exports = { createVitaModelRequest };
