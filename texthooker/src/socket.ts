import { BehaviorSubject, NEVER, Subscription, filter, switchMap } from 'rxjs';
import {
	continuousReconnect$,
	lineData$,
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

import { isGSMTextFeedWebSocketUrl, normalizeGSMWebSocketUrl } from './gsm';
import { LineType } from './types';

export class SocketConnection {
	private isPrimary: boolean;

	private websocketUrl: string;

	private socket: WebSocket | undefined;

	private socketState: BehaviorSubject<number>;

	private subscriptions: Subscription[] = [];

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
					this.websocketUrl = websocketUrl;
					this.reloadSocket();
				}
			}),
			continuousReconnect$
				.pipe(
					switchMap((continuousReconnect) =>
						continuousReconnect
							? (isPrimary ? reconnectSocket$ : reconnectSecondarySocket$).pipe(
									filter(() => this.socket?.readyState === 3)
							  )
							: NEVER
					)
				)
				.subscribe(() => this.reloadSocket())
		);
	}

	getCurrentUrl() {
		return this.websocketUrl;
	}

	connect() {
		if (this.socket?.readyState < 2) {
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
			this.socket.onclose = this.updateSocketState.bind(this);
			this.socket.onmessage = this.handleMessage.bind(this);
		} catch (error) {
			this.socketState.next(3);
		}
	}

	disconnect() {
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

	private handleOpen() {
		this.updateSocketState();

		if (!this.isPrimary || !this.socket || !isGSMTextFeedWebSocketUrl(this.websocketUrl)) {
			return;
		}

		const sessions: Record<string, string[]> = {};
		for (const line of lineData$.getValue()) {
			if (!line.gsmSessionId || line.gsmStatus === 'external') {
				continue;
			}
			(sessions[line.gsmSessionId] ||= []).push(line.id);
		}

		this.socket.send(
			JSON.stringify({
				event: 'textfeed_session_sync_request',
				sessions,
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
			if (payload.event === 'textfeed_session_sync') {
				const lines = Array.isArray(payload.lines) ? payload.lines : [];
				textfeedSessionSync$.next({
					sessionId: typeof payload.session_id === 'string' ? payload.session_id : '',
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
				});
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
		const id = isGSMLine ? payload.data.id : '';
		const lineMeta =
			payload?.data && typeof payload.data === 'object'
				? {
						excludedFromStats: Boolean(payload.data.excluded_from_stats),
						gsmSessionId: typeof payload.data.session_id === 'string' ? payload.data.session_id : undefined,
						gsmStatus: isGSMLine ? ('active' as const) : ('external' as const),
				  }
				: { gsmStatus: 'external' as const };

		newLine$.next([line, LineType.SOCKET, id, lineMeta]);
	}
}
