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

function getValidPort(value: unknown): number | null {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function buildGSMWebSocketFallbackUrl(websocketUrl: string, endpoint: unknown): string | null {
	const directPort = getValidPort((endpoint as { direct_port?: unknown } | null)?.direct_port);
	if (!directPort) return null;

	try {
		const url = new URL(websocketUrl);
		if (!['ws:', 'wss:'].includes(url.protocol) || url.port === String(directPort)) {
			return null;
		}
		url.port = String(directPort);
		return url.toString();
	} catch (_) {
		return null;
	}
}

export async function resolveGSMWebSocketFallbackUrl(websocketUrl: string): Promise<string | null> {
	if (typeof fetch !== 'function') return null;

	try {
		const endpoint = new URL(websocketUrl);
		if (!['ws:', 'wss:'].includes(endpoint.protocol)) return null;
		endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
		endpoint.pathname = '/get_websocket_port';
		endpoint.search = '';
		endpoint.hash = '';

		const controller = typeof AbortController === 'function' ? new AbortController() : null;
		const timeout = controller ? setTimeout(() => controller.abort(), 1500) : null;
		try {
			const response = await fetch(endpoint.toString(), controller ? { signal: controller.signal } : undefined);
			if (!response.ok) return null;
			return buildGSMWebSocketFallbackUrl(websocketUrl, await response.json());
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	} catch (_) {
		return null;
	}
}
