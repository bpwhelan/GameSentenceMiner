// Both standalone and hosted overlays use the backend's shared model selector.
function createMeikiModelRequest(getPort, fetchImpl = fetch) {
  return async (request = {}) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        (request.model !== undefined && !['small', 'large'].includes(request.model))) {
      throw new Error('Invalid MeikiOCR model size');
    }
    const changing = request.model !== undefined;
    const response = await fetchImpl(`http://127.0.0.1:${getPort()}/api/ocr/meiki-model`, {
      method: changing ? 'POST' : 'GET',
      headers: changing ? { 'Content-Type': 'application/json' } : undefined,
      body: changing ? JSON.stringify({ model: request.model }) : undefined,
      signal: AbortSignal.timeout(changing ? 120000 : 5000),
    });
    if (!response.ok) throw new Error(`Could not reach MeikiOCR settings (HTTP ${response.status})`);
    const status = await response.json();
    if (!status || !['small', 'large'].includes(status.model)) throw new Error('Invalid MeikiOCR model status');
    return status;
  };
}

module.exports = { createMeikiModelRequest };
