<script lang="ts">
	import { mdiConnection } from '@mdi/js';
	import { onMount } from 'svelte';
	import { SocketConnection } from '../socket';
	import {
		continuousReconnect$,
		isPaused$,
		openDialog$,
		reconnectSecondarySocket$,
		reconnectSocket$,
		secondarySocketState$,
		secondaryWebsocketUrl$,
		showConnectionErrors$,
		socketState$,
		websocketUrl$,
	} from '../stores/stores';
	import Icon from './Icon.svelte';

	export let isPrimary = true;

	let socketConnection: SocketConnection | undefined;
	let intitialAttemptDone = false;
	let wasConnected = false;
	let closeRequested = false;
	let socketState = isPrimary ? socketState$ : secondarySocketState$;

	$: connectedWithLabel = updateConnectedWithLabel(wasConnected);

	$: handleSocketState($socketState);

	onMount(() => {
		toggleSocket();

		return () => {
			closeRequested = true;
			socketConnection?.cleanUp();
		};
	});

	function handleSocketState(socketStateValue) {
		switch (socketStateValue) {
			case 0:
				wasConnected = false;
				closeRequested = false;
				break;
			case 1:
				intitialAttemptDone = true;
				wasConnected = true;
				break;
			case 3:
				const socketType = isPrimary ? 'primary' : 'secondary';
				const socketUrl = isPrimary ? $websocketUrl$ : $secondaryWebsocketUrl$;

				if (
					$showConnectionErrors$ &&
					!closeRequested &&
					intitialAttemptDone &&
					socketUrl &&
					(wasConnected || !$continuousReconnect$)
				) {
					$openDialog$ = {
						type: 'error',
						message: wasConnected
							? `Lost Connection to ${socketType} Websocket`
							: `Unable to connect to ${socketType} Websocket`,
						showCancel: false,
					};
				}

				$isPaused$ = true;

				intitialAttemptDone = true;
				wasConnected = false;

				if (!closeRequested) {
					(isPrimary ? reconnectSocket$ : reconnectSecondarySocket$).next();
				}

				break;

			default:
				break;
		}

		connectedWithLabel = updateConnectedWithLabel(wasConnected);
	}

	function updateConnectedWithLabel(hasConnection: boolean) {
		return hasConnection
			? `Connected with ${isPrimary ? $websocketUrl$ : $secondaryWebsocketUrl$}`
			: 'Not Connected';
	}

	async function toggleSocket() {
		if ($socketState === 1 && socketConnection) {
			closeRequested = true;
			socketConnection.disconnect();
		} else {
			socketConnection = socketConnection || new SocketConnection(isPrimary);
			socketConnection.connect();
		}
	}
</script>

{#if $socketState !== 0}
	<div
		class="hover:text-primary"
		class:text-red-500={$socketState !== -1}
		class:text-green-700={$socketState === 1}
		title={connectedWithLabel}
	>
		<Icon path={mdiConnection} class="cursor-pointer mx-2" on:click={toggleSocket} />
	</div>
{:else}
	<span class="animate-ping relative inline-flex rounded-full h-3 w-3 mx-3 bg-primary" />
{/if}
