import { BehaviorSubject, NEVER, Subscription, filter, switchMap } from 'rxjs';
import {
	continuousReconnect$,
	newLine$,
	reconnectSecondarySocket$,
	reconnectSocket$,
	secondarySocketState$,
	secondaryWebsocketUrl$,
	socketState$,
	texthookerAudioEvents$,
	websocketUrl$,
} from './stores/stores';

import { LineType } from './types';

export class SocketConnection {
	private websocketUrl: string;

	private socket: WebSocket | undefined;

	private socketState: BehaviorSubject<number>;

	private subscriptions: Subscription[] = [];

	constructor(isPrimary = true) {
		this.socketState = isPrimary ? socketState$ : secondarySocketState$;
		this.subscriptions.push(
			(isPrimary ? websocketUrl$ : secondaryWebsocketUrl$).subscribe((websocketUrl) => {
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
			this.socket.onopen = this.updateSocketState.bind(this);
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

	private handleMessage(event: MessageEvent) {
		let line = event.data;
		let payload: Record<string, any> | undefined;

		try {
			payload = JSON.parse(event.data);
		} catch (_) {
			payload = undefined;
		}

		if (payload?.event) {
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
		const id = payload?.data?.id || '';
		const lineMeta =
			payload?.data && typeof payload.data === 'object'
				? {
						excludedFromStats: Boolean(payload.data.excluded_from_stats),
				  }
				: undefined;

		newLine$.next([line, LineType.SOCKET, id, lineMeta]);
	}
}
