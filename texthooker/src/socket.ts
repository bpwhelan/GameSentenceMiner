import { BehaviorSubject, NEVER, Subscription, filter, switchMap } from 'rxjs';
import {
	continuousReconnect$,
	lineData$,
	maxLines$,
	newLine$,
	reconnectSecondarySocket$,
	reconnectSocket$,
	secondarySocketState$,
	secondaryWebsocketUrl$,
	socketState$,
	textfeedSessionSync$,
	texthookerAudioEvents$,
	websocketUrl$,
} from './stores/stores';

import {
	isGSMTextFeedWebSocketUrl,
	normalizeGSMWebSocketUrl,
	resolveGSMWebSocketFallbackUrl,
} from './gsm';
import { getTextFeedSessionSyncLineLimit } from './session-sync';
import { LineType } from './types';

export class SocketConnection {
	private isPrimary: boolean;

	private websocketUrl = '';

	private configuredWebsocketUrl = '';

	private fallbackLookupInFlight = false;

	private manualDisconnectRequested = false;

	private socket: WebSocket | undefined;

	private socketState: BehaviorSubject<number>;

	private subscriptions: Subscription[] = [];

	private textFeedSyncRequestedIds = new Map<string, string[]>();

	constructor(isPrimary = true) {
		this.isPrimary = isPrimary;
		this.socketState = isPrimary ? socketState$ : secondarySocketState$;
		const websocketUrlStore = isPrimary ? websocketUrl$ : secondaryWebsocketUrl$;
		this.subscriptions.push(
			websocketUrlStore.subscribe((websocketUrl) => {
				const normalizedUrl = isPrimary ? normalizeGSMWebSocketUrl(websocketUrl) : websocketUrl;
				if (normalizedUrl !== websocketUrl) {
					websocketUrlStore.next(normalizedUrl);
					return;
				}
				if (websocketUrl !== this.websocketUrl) {
					this.configuredWebsocketUrl = websocketUrl;
					this.websocketUrl = websocketUrl;
					this.reloadSocket();
				}
			}),
			continuousReconnect$
				.pipe(
					switchMap((continuousReconnect) =>
						continuousReconnect
							? (isPrimary ? reconnectSocket$ : reconnectSecondarySocket$).pipe(
									filter(() => this.socket?.readyState === 3),
								)
							: NEVER,
					),
				)
				.subscribe(() => this.reloadSocket()),
		);
	}

	getCurrentUrl() {
		return this.websocketUrl;
	}

	connect() {
		this.manualDisconnectRequested = false;
		if ((this.socket?.readyState ?? WebSocket.CLOSED) < WebSocket.CLOSING) {
			return;
		}

		if (!this.websocketUrl) {
			this.socketState.next(3);
			return;
		}

		this.socketState.next(0);

		try {
			this.socket = new WebSocket(this.websocketUrl);
			this.socket.onopen = this.handleOpen.bind(this);
			this.socket.onclose = this.handleClose.bind(this);
			this.socket.onmessage = this.handleMessage.bind(this);
		} catch (error) {
			this.socketState.next(3);
		}
	}

	disconnect() {
		this.manualDisconnectRequested = true;
		if (this.socket?.readyState === 1) {
			this.socket.close(1000, 'User Request');
		}
	}

	cleanUp() {
		this.disconnect();

		for (let index = 0, { length } = this.subscriptions; index < length; index += 1) {
			this.subscriptions[index].unsubscribe();
		}
	}

	private reloadSocket() {
		this.disconnect();
		this.socket = undefined;
		this.connect();
	}

	private updateSocketState() {
		if (!this.socket) {
			return;
		}

		this.socketState.next(this.socket.readyState);
	}

	private handleClose() {
		const closedSocket = this.socket;
		this.updateSocketState();
		if (!closedSocket) return;
		void this.tryGSMFallback(closedSocket);
	}

	private async tryGSMFallback(closedSocket: WebSocket) {
		if (
			!this.isPrimary ||
			this.manualDisconnectRequested ||
			this.fallbackLookupInFlight ||
			this.socket !== closedSocket ||
			!isGSMTextFeedWebSocketUrl(this.configuredWebsocketUrl)
		) {
			return;
		}

		this.fallbackLookupInFlight = true;
		try {
			const fallbackUrl = await resolveGSMWebSocketFallbackUrl(this.configuredWebsocketUrl);
			if (
				fallbackUrl &&
				fallbackUrl !== this.websocketUrl &&
				this.socket === closedSocket &&
				closedSocket.readyState === WebSocket.CLOSED
			) {
				this.websocketUrl = fallbackUrl;
				this.reloadSocket();
			}
		} finally {
			this.fallbackLookupInFlight = false;
		}
	}

	private handleOpen() {
		this.updateSocketState();

		if (!this.isPrimary || !this.socket || !isGSMTextFeedWebSocketUrl(this.websocketUrl)) {
			return;
		}

		this.socket.send(
			JSON.stringify({
				event: 'text_v2_snapshot_request',
				after_sequence: Math.max(0, ...lineData$.getValue().map((line) => line.streamSequence ?? 0)),
				max_lines: getTextFeedSessionSyncLineLimit(maxLines$.getValue()),
			}),
		);
	}

	private handleMessage(event: MessageEvent) {
		let line = event.data;
		let payload: Record<string, any> | undefined;

		try {
			payload = JSON.parse(event.data);
		} catch (_) {
			payload = undefined;
		}

		if (payload?.event) {
			if (payload.event === 'text_v2_snapshot') {
				const lines = (Array.isArray(payload.lines) ? payload.lines : []).sort(
					(a, b) => Number(a?.stream_sequence ?? 0) - Number(b?.stream_sequence ?? 0),
				);
				const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
				const orderedIds = lines.filter((item) => typeof item?.id === 'string').map((item) => item.id);
				textfeedSessionSync$.next({
					sessionId,
					orderedIds,
					activeIds: lines
						.filter((item) => item?.state !== 'expired' && typeof item?.id === 'string')
						.map((item) => item.id),
					timedOutIds: lines
						.filter((item) => item?.state === 'expired' && typeof item?.id === 'string')
						.map((item) => item.id),
					missingLines: lines
						.filter((item) => typeof item?.id === 'string' && typeof item?.text === 'string')
						.map((item) => ({
							id: item.id,
							text: item.text,
							excludedFromStats: Boolean(item.excluded_from_stats),
							streamSequence: Number(item.stream_sequence ?? 0),
							revision: Number(item.revision ?? 1),
							recordState: item.state,
						})),
					requestedIds: lineData$
						.getValue()
						.filter((line) => line.gsmSessionId === sessionId)
						.map((line) => line.id),
				});
				return;
			}
			if (
				payload.event === 'text_v2_append' ||
				payload.event === 'text_v2_update' ||
				payload.event === 'text_v2_freeze' ||
				payload.event === 'text_v2_expire'
			) {
				this.emitV2Line(payload.data);
				return;
			}
			if (payload.event === 'textfeed_session_sync') {
				const lines = Array.isArray(payload.lines) ? payload.lines : [];
				const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
				textfeedSessionSync$.next({
					sessionId,
					orderedIds: Array.isArray(payload.ordered_ids) ? payload.ordered_ids : [],
					activeIds: Array.isArray(payload.active_ids) ? payload.active_ids : [],
					timedOutIds: Array.isArray(payload.timed_out_ids) ? payload.timed_out_ids : [],
					missingLines: lines
						.filter(
							(item) =>
								typeof item?.data?.id === 'string' &&
								typeof (item?.sentence ?? item?.data?.text) === 'string',
						)
						.map((item) => ({
							id: item.data.id,
							text: item.sentence ?? item.data.text,
							excludedFromStats: Boolean(item.data.excluded_from_stats),
						})),
					requestedIds: this.textFeedSyncRequestedIds.get(sessionId) ?? [],
				});
				this.textFeedSyncRequestedIds.delete(sessionId);
				return;
			}
			if (payload.event === LineType.RESETCHECKBOXES) {
				newLine$.next(['', LineType.RESETCHECKBOXES, '']);
				return;
			}
			if (payload.event === 'reset_buttons' || String(payload.event).startsWith('audio_')) {
				texthookerAudioEvents$.next(payload);
				return;
			}
		}

		line = payload?.sentence || event.data;
		const isGSMLine = payload?.event === 'text_received' && typeof payload?.data?.id === 'string';
		const id = isGSMLine && payload ? payload.data.id : '';
		const streamSequence = isGSMLine ? Number(payload?.data?.stream_sequence ?? Number.NaN) : Number.NaN;
		const revision = isGSMLine ? Number(payload?.data?.revision ?? Number.NaN) : Number.NaN;
		const lineMeta =
			payload?.data && typeof payload.data === 'object'
				? {
						excludedFromStats: Boolean(payload.data.excluded_from_stats),
						gsmSessionId: typeof payload.data.session_id === 'string' ? payload.data.session_id : undefined,
						gsmStatus: isGSMLine ? ('active' as const) : ('external' as const),
						...(Number.isFinite(streamSequence) ? { streamSequence } : {}),
						...(Number.isFinite(revision) ? { revision } : {}),
						...(typeof payload.data.state === 'string' ? { recordState: payload.data.state } : {}),
				  }
				: { gsmStatus: 'external' as const };

		newLine$.next([line, LineType.SOCKET, id, lineMeta]);
	}

	private emitV2Line(data: Record<string, any> | undefined, sessionBackfill = false) {
		if (!data || typeof data.id !== 'string' || typeof data.text !== 'string') return;
		newLine$.next([
			data.text,
			LineType.SOCKET,
			data.id,
			{
				excludedFromStats: Boolean(data.excluded_from_stats),
				gsmSessionId: typeof data.session_id === 'string' ? data.session_id : undefined,
				gsmStatus: data.state === 'expired' ? 'timed_out' : 'active',
				streamSequence: Number(data.stream_sequence ?? 0),
				revision: Number(data.revision ?? 1),
				recordState: data.state,
				sessionBackfill,
			},
		]);
	}
}
