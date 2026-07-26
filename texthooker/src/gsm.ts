export function getGSMEndpoint(endpoint: string) {
	if (window.location.port === '4173' || window.location.port === '5174') {
		return window.location.protocol + '//' + window.location.hostname + ':7275' + endpoint;
	}
	return endpoint;
}

const GSM_TEXTHOOKER_WEBSOCKET_PATH = '/ws/texthooker';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeGSMWebSocketUrl(websocketUrl: string) {
	try {
		const url = new URL(websocketUrl);
		if (!['ws:', 'wss:'].includes(url.protocol) || (url.pathname && url.pathname !== '/')) {
			return websocketUrl;
		}

		const isSameHost = url.host === window.location.host;
		const isDefaultLocalGSM = LOOPBACK_HOSTS.has(url.hostname) && (!url.port || url.port === '7275');
		if (!isSameHost && !isDefaultLocalGSM) {
			return websocketUrl;
		}

		if (window.location.protocol === 'https:' && url.protocol === 'ws:' && isDefaultLocalGSM) {
			return `wss://${window.location.host}${GSM_TEXTHOOKER_WEBSOCKET_PATH}`;
		}

		url.pathname = GSM_TEXTHOOKER_WEBSOCKET_PATH;
		return url.toString();
	} catch (_) {
		return websocketUrl;
	}
}

export function isGSMTextFeedWebSocketUrl(websocketUrl: string) {
	try {
		const pathname = new URL(websocketUrl).pathname.replace(/\/+$/, '').toLowerCase();
		return pathname === GSM_TEXTHOOKER_WEBSOCKET_PATH;
	} catch (_) {
		return false;
	}
}
