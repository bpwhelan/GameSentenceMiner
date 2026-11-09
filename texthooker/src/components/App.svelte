<script lang="ts">
	import {
		mdiArrowULeftTop,
		mdiCancel,
		mdiChartBar,
		mdiChevronDown,
		mdiChevronLeft,
		mdiChevronRight,
		mdiChevronUp,
		mdiCog,
		mdiContentSaveAll,
		mdiDelete,
		mdiDeleteForever,
		mdiDatabase,
		mdiDatabaseOff,
		mdiFolderMultipleImage,
		mdiInformationOutline,
		mdiNoteEdit,
		mdiPause,
		mdiPlay,
		mdiVolumeHigh,
		mdiWindowMaximize,
		mdiWindowRestore,
	} from '@mdi/js';
	import { debounceTime, filter, fromEvent, map, NEVER, switchMap, tap, throttleTime, type Subscription } from 'rxjs';
	import { onMount, tick } from 'svelte';
	import { quintInOut } from 'svelte/easing';
	import { fade, fly } from 'svelte/transition';
	import {
		actionHistory$,
		alwaysScrollToNewest$,
		allowNewLineDuringPause$,
		allowPasteDuringPause$,
		autoStartTimerDuringPause$,
		autoStartTimerDuringPausePaste$,
		blockCopyOnPage$,
		customCSS$,
		remoteCSS$,
		dialogOpen$,
		displayVertical$,
		enabledReplacements$,
		enablePaste$,
		filterNonCJKLines$,
		flashOnMissedLine$,
		flashOnPauseTimeout$,
		fontSize$,
		isPaused$,
		lastPipHeight$,
		lastPipWidth$,
		lineData$,
		lineIDs$,
		timedOutIDs$,
		maxLines$,
		maxPipLines$,
		mergeEqualLineStarts$,
		newLine$,
		notesOpen$,
		onlineFont$,
		openDialog$,
		preventGlobalDuplicate$,
		preventLastDuplicate$,
		removeAllWhitespace$,
		replacements$,
		reverseLineOrder$,
		secondaryWebsocketUrl$,
		settingsOpen$,
		showSpinner$,
		syncTextFeedPauseWithGSMStats$,
		textfeedSessionSync$,
		theme$,
		websocketUrl$,
		trimAudioWithVAD$,
		trimVideoWithVAD$,
		texthookerAudioEvents$,
	} from '../stores/stores';
	import {
		type LineItem,
		type LineItemEditEvent,
		LineType,
		OnlineFont,
		type SavedClip,
		type TextFeedSessionSync,
		Theme,
	} from '../types';
	import {
		buildTextFeedSessionSyncPlan,
		deduplicateLineData,
		DEFAULT_TEXTFEED_SESSION_SYNC_LINE_LIMIT,
		reconcileTextFeedSessionSyncBatch,
		TEXTFEED_SESSION_SYNC_BATCH_SIZE,
	} from '../session-sync';
	import {
		applyAfkBlur,
		applyCustomCSS,
		applyReplacements,
		generateRandomUUID,
		getErrorMessage,
		isScrolledToEnd,
		newLineCharacter,
		reduceToEmptyString,
		setAutoScrollStick,
		shouldAutoScroll,
		updateScroll
	} from '../util';
	import DialogManager from './DialogManager.svelte';
	import Icon from './Icon.svelte';
	import Line from './Line.svelte';
	import Notes from './Notes.svelte';
	import Presets from './Presets.svelte';
	import Settings from './Settings.svelte';
	import SocketConnector from './SocketConnector.svelte';
	import Spinner from './Spinner.svelte';
	import Stats from './Stats.svelte';
	import { describeSavedClips, fetchSavedClips, getGSMEndpoint, trashSavedClips } from '../gsm';
	import {
		selectMiningRange, miningSelectionChanges, type MiningUpdate, type MiningStartDetail, type MiningClickDetail,
	} from '../mining-selection';

	let miningSelectedIds = new Set<string>();
	let miningAnchor = '';
	let miningSaving = false;
	let miningError = '';
	let miningVersion = 0;
	let miningResetVersion = 0;
	let inFlightMiningUpdates: MiningUpdate[] = [];
	let miningClickSuppression: { view: Window; until: number } | undefined;
	const pendingMiningUpdates = new Map<string, boolean>();
	let miningDrag: {
		anchor: string; end: string; initial: Set<string>; checked: boolean;
		view: Window; document: Document; pointerId: number; x: number; y: number; frame: number;
		startX: number; startY: number; moved: boolean; mining: boolean;
	} | undefined;

	function miningOrder() {
		const lines: LineItem[] = clipsViewOpen ? clipLines : $lineData$;
		return lines
			.filter((line) => line.gsmStatus === 'active' || (!line.gsmStatus && $lineIDs$.includes(line.id)))
			.map((line) => line.id);
	}

	function receiveMiningSelection(ids: string[]) {
		if (!miningDrag && !miningSaving && !pendingMiningUpdates.size) miningSelectedIds = new Set(ids);
	}

	function beginMiningSelection({ detail }: CustomEvent<MiningStartDetail>) {
		const { id, checked, event } = detail;
		const order = miningOrder();
		if (!order.includes(id)) return;
		if (miningDrag) finishMiningSelection(false);
		const view = (event.currentTarget as HTMLElement)?.ownerDocument.defaultView || window;
		const mining = event.shiftKey;
		const anchor = event.shiftKey && order.includes(miningAnchor) ? miningAnchor : id;
		miningDrag = { anchor, end: id, initial: new Set(miningSelectedIds), checked, view,
			document: view.document, pointerId: event.pointerId, x: event.clientX, y: event.clientY, frame: 0,
			startX: event.clientX, startY: event.clientY, moved: false, mining };
		if (mining) {
			view.getSelection()?.removeAllRanges();
			if (!event.shiftKey) miningAnchor = id;
			miningVersion += 1;
			miningSelectedIds = selectMiningRange(miningDrag.initial, order, anchor, id, checked);
		}
		view.addEventListener('pointermove', moveMiningSelection);
		view.addEventListener('pointerup', endMiningSelection);
		view.addEventListener('pointercancel', cancelMiningSelection);
		view.addEventListener('blur', cancelMiningSelection);
	}

	function miningTargetId() {
		if (!miningDrag) return undefined;
		const hit = miningDrag.document.elementFromPoint?.(miningDrag.x, miningDrag.y)?.closest<HTMLElement>('[data-mining-id]');
		return hit?.dataset.miningId;
	}

	function updateMiningTarget() {
		if (!miningDrag?.mining) return;
		const id = miningTargetId();
		if (id && id !== miningDrag.end && miningOrder().includes(id)) {
			miningDrag.end = id;
			miningSelectedIds = selectMiningRange(miningDrag.initial, miningOrder(), miningDrag.anchor, id, miningDrag.checked);
		}
	}

	function scrollMiningSelection() {
		const drag = miningDrag;
		if (!drag?.mining) return;
		drag.frame = 0;
		const vertical = $displayVertical$ && drag.view === window;
		const position = vertical ? drag.x : drag.y;
		const extent = vertical ? drag.view.innerWidth : drag.view.innerHeight;
		const start = vertical ? 48 : 90;
		const speed = position < start ? -Math.min(18, (start - position) / 3)
			: position > extent - 48 ? Math.min(18, (position - extent + 48) / 3) : 0;
		if (speed) {
			const x = vertical ? speed : 0;
			const y = vertical ? 0 : speed;
			const scrollsInContainer = vertical
				? lineContainer.scrollWidth > lineContainer.clientWidth
				: lineContainer.clientHeight > 0 && lineContainer.scrollHeight > lineContainer.clientHeight;
			if (drag.view === window && scrollsInContainer) lineContainer.scrollBy(x, y);
			else drag.view.scrollBy(x, y);
			updateMiningTarget();
			drag.frame = drag.view.requestAnimationFrame(scrollMiningSelection);
		}
	}

	function moveMiningSelection(event: PointerEvent) {
		const drag = miningDrag;
		if (!drag || event.pointerId !== drag.pointerId) return;
		drag.x = event.clientX;
		drag.y = event.clientY;
		if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 6) drag.moved = true;
		if (!drag.mining) {
			const id = miningTargetId();
			// Leave the browser's native text selection alone until another row is crossed.
			if (!drag.moved || !id || id === drag.anchor || !miningOrder().includes(id)) return;
			miningDrag!.mining = true;
			miningAnchor = drag.anchor;
			miningVersion += 1;
		}
		event.preventDefault();
		drag.view.getSelection()?.removeAllRanges();
		updateMiningTarget();
		if (!drag.frame) drag.frame = drag.view.requestAnimationFrame(scrollMiningSelection);
	}

	function finishMiningSelection(commit = true) {
		const drag = miningDrag;
		if (!drag) return;
		drag.view.removeEventListener('pointermove', moveMiningSelection);
		drag.view.removeEventListener('pointerup', endMiningSelection);
		drag.view.removeEventListener('pointercancel', cancelMiningSelection);
		drag.view.removeEventListener('blur', cancelMiningSelection);
		drag.view.cancelAnimationFrame(drag.frame);
		miningDrag = undefined;
		if (drag.mining) {
			if (commit) queueMiningSelection(miningSelectionChanges(drag.initial, miningSelectedIds));
			else miningSelectedIds = drag.initial;
		}
	}
	function endMiningSelection(event: PointerEvent) {
		if (event.pointerId !== miningDrag?.pointerId) return;
		if (miningDrag.mining || miningDrag.moved) {
			miningClickSuppression = { view: miningDrag.view, until: event.timeStamp + 100 };
		}
		finishMiningSelection();
	}
	function cancelMiningSelection() { finishMiningSelection(false); }

	function clickMiningRow({ detail }: CustomEvent<MiningClickDetail>) {
		const { id, event } = detail;
		const view = (event.currentTarget as HTMLElement)?.ownerDocument.defaultView || window;
		if (event.detail > 2 || (miningClickSuppression?.view === view && event.timeStamp <= miningClickSuppression.until)) return;
		if (event.detail < 2 && !view.getSelection()?.isCollapsed) return;
		// Two native clicks restore the original checked state before double-click editing starts.
		toggleMiningSelection(new CustomEvent('miningToggle', {
			detail: { id, checked: !miningSelectedIds.has(id), shiftKey: event.shiftKey },
		}));
	}

	function toggleMiningSelection({ detail }: CustomEvent<{ id: string; checked: boolean; shiftKey: boolean }>) {
		const before = miningSelectedIds;
		const anchor = detail.shiftKey && miningOrder().includes(miningAnchor) ? miningAnchor : detail.id;
		if (!detail.shiftKey) miningAnchor = detail.id;
		miningSelectedIds = selectMiningRange(before, miningOrder(), anchor, detail.id, detail.checked);
		miningVersion += 1;
		queueMiningSelection(miningSelectionChanges(before, miningSelectedIds));
	}

	function queueMiningSelection(updates: MiningUpdate[]) {
		for (const update of updates) pendingMiningUpdates.set(update.id, update.checked);
		if (updates.length) void saveMiningSelection();
	}

	async function saveMiningSelection() {
		if (miningSaving || !pendingMiningUpdates.size) return;
		// A failed request can outlive a cancelled drag. Retry the current committed
		// state, never the temporary range that was visible when the failure arrived.
		const committed = miningDrag?.initial ?? miningSelectedIds;
		const updates = [...pendingMiningUpdates.keys()].map((id) => ({ id, checked: committed.has(id) }));
		inFlightMiningUpdates = updates;
		pendingMiningUpdates.clear();
		const version = miningVersion;
		const resetVersion = miningResetVersion;
		miningSaving = true;
		miningError = '';
		try {
			const response = await fetch(getGSMEndpoint('/update_checkboxes'), {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }),
			});
			if (!response.ok) throw new Error('Selection request failed');
			const data = await response.json();
			if (version === miningVersion && !miningDrag && !pendingMiningUpdates.size && Array.isArray(data.selected_ids)) miningSelectedIds = new Set(data.selected_ids);
		} catch (error) {
			for (const update of updates) {
				if (!pendingMiningUpdates.has(update.id)) pendingMiningUpdates.set(update.id, miningSelectedIds.has(update.id));
			}
			if (resetVersion === miningResetVersion) miningError = 'Could not save mining selection.';
		} finally {
			inFlightMiningUpdates = [];
			miningSaving = false;
			if (!miningError && pendingMiningUpdates.size) void saveMiningSelection();
		}
	}

	function clearMiningSelection() {
		if (miningDrag) finishMiningSelection(false);
		const before = miningSelectedIds;
		miningSelectedIds = new Set();
		miningAnchor = '';
		miningVersion += 1;
		queueMiningSelection(miningSelectionChanges(before, miningSelectedIds));
	}

	let isSmFactor = false;
	let settingsComponent: Settings;
	let selectedLineIds: string[] = [];
	let settingsContainer: HTMLElement;
	let settingsElement: SVGElement;
	let lineContainer: HTMLElement;
	let lineElements: Line[] = [];
	let lineInEdit = false;
	let blockNextExternalLine = false;
	let pipContainer: HTMLElement;
	let pipWindow: Window | undefined;
	let pipResizeTimeout: number;
	let hasPipFocus = false;
	let audioEventsSub: Subscription | undefined;
	let savingClipIds: string[] = [];
	let savedClips: SavedClip[] = [];
	let clipsViewOpen = false;
	let audioElement: HTMLAudioElement | undefined;
	let audioWidgetVisible = false;
	let audioWidgetText = '';
	let activeAudioLineId = '';
	let textFeedSessionSyncVersion = 0;
	let pendingAudioLineId = '';
	let browserAudioPlaying = false;
	let currentGSMSessionId = '';
	let gsmTextIntakePaused: boolean | undefined;
	let gsmTextIntakeStateRequestPending = false;
	let timerPauseClarificationShown = false;
	const REMOVED_GSM_LINES_STORAGE_KEY = 'bannou-texthooker-removedGSMLineIds';
	const storedRemovedGSMLines = loadRemovedGSMLines();
	let removedGSMSessionId = storedRemovedGSMLines.sessionId;
	let removedGSMLineIds = new Set(storedRemovedGSMLines.ids);
	let audioCurrentTime = 0;
	let audioDuration = 0;
	let lastBrowserAudioStartAt = 0;
	const AUDIO_PLAY_START_GUARD_MS = 350;
	const TIMER_PAUSE_CLARIFICATION_KEY = 'gsm-texthooker-timer-pause-clarification-shown';

	const cjkCharacters = /[\p{scx=Hira}\p{scx=Kana}\p{scx=Han}]/imu;
	const initialLineData = lineData$.getValue();
	const deduplicatedInitialLineData = deduplicateLineData(initialLineData);
	if (deduplicatedInitialLineData !== initialLineData) {
		lineData$.next(deduplicatedInitialLineData);
	}

	const uniqueLines$ = preventGlobalDuplicate$.pipe(
		map((preventGlobalDuplicate) =>
			preventGlobalDuplicate ? new Set<string>($lineData$.map((line) => line.text)) : new Set<string>(),
		),
	);

	const handleLine$ = newLine$.pipe(
		filter(([value, lineType, id, lineMeta]) => {
			const isResetCheckboxes = lineType === LineType.RESETCHECKBOXES;
			const isAuthoritativeV2 = Number.isFinite(Number(lineMeta?.streamSequence));
			const isReplayBufferExpiry = lineMeta?.gsmStatus === 'timed_out' || lineMeta?.recordState === 'expired';
			const isPaste = lineType === LineType.PASTE;
			const shouldAutoStartTimer =
				!isReplayBufferExpiry && (isPaste ? $autoStartTimerDuringPausePaste$ : $autoStartTimerDuringPause$);
			const hasNoUserInteraction = !isPaste || (!$notesOpen$ && !$dialogOpen$ && !$settingsOpen$ && !lineInEdit);
			const skipExternalLine = blockNextExternalLine && lineType === LineType.EXTERNAL;

			if (skipExternalLine) {
				blockNextExternalLine = false;
			}

			if (isResetCheckboxes) {
				resetCheckBoxes()
				return false;
			}
			// Keep corrections and status updates for displayed stream records flowing
			// while paused. New records must still respect the pause settings below.
			if (isAuthoritativeV2 && $lineData$.some((line) => line.id === id)) {
				if ($isPaused$ && shouldAutoStartTimer && hasNoUserInteraction && !skipExternalLine) {
					$isPaused$ = false;
				}
				return true;
			}

			if (
				(!$isPaused$ ||
					shouldAutoStartTimer ||
					(isPaste ? $allowPasteDuringPause$ : $allowNewLineDuringPause$)) &&
				hasNoUserInteraction &&
				!skipExternalLine
			) {
				if ($isPaused$ && shouldAutoStartTimer) {
					$isPaused$ = false;
				}

				return true;
			}

			if (!skipExternalLine && hasNoUserInteraction && $flashOnMissedLine$) {
				handleMissedLine();
			}

			return false;
		}),
		tap((newLine: [string, LineType, string, Partial<LineItem>?]) => {
			const [lineContent, requestedType, requestedId, requestedLineMeta] = newLine;
			const type = requestedType || LineType.SOCKET;
			const id = requestedId || generateRandomUUID();
			const lineMeta: Partial<LineItem> = { gsmStatus: 'external', ...(requestedLineMeta ?? {}) };
			if (lineMeta.gsmSessionId && isRemovedGSMLine(id, lineMeta.gsmSessionId)) {
				return;
			}
			const isAuthoritativeV2 = Number.isFinite(Number(lineMeta.streamSequence));
			const text = transformLine(lineContent, type !== LineType.TL, !isAuthoritativeV2);
			if (!text) {
				return;
			}

			const existingLineIndex = $lineData$?.findIndex((line) => line.id === id) ?? -1;
			if (existingLineIndex >= 0) {
				const existing = $lineData$[existingLineIndex];
				const incomingRevision = Number(lineMeta.revision ?? 1);
				if (incomingRevision > Number(existing.revision ?? 0)) {
					$lineData$ = $lineData$.map((item, index) =>
						index === existingLineIndex ? { ...item, ...lineMeta, text } : item,
					);
				}
				if (lineMeta.gsmStatus === 'timed_out') {
					$lineIDs$ = $lineIDs$.filter((lineId) => lineId !== id);
					if (!$timedOutIDs$.includes(id)) $timedOutIDs$ = [...$timedOutIDs$, id];
				}
				return;
			}

			if (lineMeta.gsmStatus === 'active') {
				$lineIDs$ = [...$lineIDs$, id];
			} else if (lineMeta.gsmStatus === 'timed_out' && !$timedOutIDs$.includes(id)) {
				$timedOutIDs$ = [...$timedOutIDs$, id];
			}

			if (text) {
				// Capture before render: content grows, so a later check is too late.
				const mainAtEnd = isScrolledToEnd(window, lineContainer, $reverseLineOrder$, $displayVertical$);
				const mainShouldScroll = shouldAutoScroll($alwaysScrollToNewest$, mainAtEnd);
				setAutoScrollStick(false, mainShouldScroll);
				if (pipWindow) {
					setAutoScrollStick(
						true,
						shouldAutoScroll(
							$alwaysScrollToNewest$,
							isScrolledToEnd(pipWindow, pipContainer, $reverseLineOrder$, false),
						),
					);
				}

				// Tally lines that skipped autoscroll so the indicator can show them.
				if (!mainShouldScroll) {
					newLinesBelow += 1;
				}

				const nextLineData = [
					...applyMaxLinesAndGetRemainingLineData(1),
					{ id, text, ...lineMeta },
				];
				$lineData$ = isAuthoritativeV2 ? nextLineData : applyEqualLineStartMerge(nextLineData);
			}
		}),
		reduceToEmptyString(),
	);

	const handleTextFeedSessionSync$ = textfeedSessionSync$.pipe(
		tap((sync: TextFeedSessionSync) => void applyTextFeedSessionSync(sync)),
		reduceToEmptyString(),
	);

	const pasteHandler$ = enablePaste$.pipe(
		switchMap((enablePaste) => (enablePaste ? fromEvent<ClipboardEvent>(document, 'paste') : NEVER)),
		tap((event) => newLine$.next([event.clipboardData?.getData('text/plain') ?? '', LineType.PASTE, ''])),
		reduceToEmptyString(),
	);

	const copyBlocker$ = blockCopyOnPage$.pipe(
		switchMap((blockCopyOnPage) => {
			blockNextExternalLine = false;

			return blockCopyOnPage ? fromEvent(document, 'copy') : NEVER;
		}),
		tap(() => (blockNextExternalLine = true)),
		reduceToEmptyString(),
	);

	const resizeHandler$ = fromEvent(window, 'resize').pipe(
		debounceTime(500),
		tap(mountFunction),
		reduceToEmptyString(),
	);

	// Capture-phase so element scroll (vertical mode) is caught too, not just window.
	const scrollHandler$ = fromEvent(window, 'scroll', { capture: true, passive: true }).pipe(
		throttleTime(100, undefined, { leading: true, trailing: true }),
		tap(() => (isAtNewest = isScrolledToEnd(window, lineContainer, $reverseLineOrder$, $displayVertical$))),
		reduceToEmptyString(),
	);

	let isAtNewest = true;
	let newLinesBelow = 0;

	$: if (isAtNewest) newLinesBelow = 0;
	$: showScrollToNewest = !isAtNewest && !!$lineData$.length;
	$: newestIconPath = $displayVertical$
		? $reverseLineOrder$
			? mdiChevronRight
			: mdiChevronLeft
		: $reverseLineOrder$
			? mdiChevronUp
			: mdiChevronDown;

	$: iconSize = isSmFactor ? '1.5rem' : '1.25rem';
	$: audioProgressPercent = audioDuration > 0 ? Math.min(100, (audioCurrentTime / audioDuration) * 100) : 0;

	$: $enabledReplacements$ = $replacements$.filter((replacment) => replacment.enabled);

	$: pipAvailable = 'documentPictureInPicture' in window && !!pipContainer;

	$: pipLines = pipAvailable && $lineData$ ? $lineData$.slice(-$maxPipLines$) : [];

	$: if (pipWindow) {
		pipWindow.document.body.dataset.theme = $theme$;

		applyCustomCSS(pipWindow.document, $customCSS$, $remoteCSS$);
	}

	onMount(() => {
		mountFunction();
		initializeAudioElement();
		void fetchGSMTextIntakePausedState();
		audioEventsSub = texthookerAudioEvents$.subscribe(handleAudioEvent);
		void loadSavedClips();
		window.addEventListener('focus', loadSavedClips);

		return () => {
			textFeedSessionSyncVersion += 1;
			audioEventsSub?.unsubscribe();
			finishMiningSelection(false);
			window.removeEventListener('focus', loadSavedClips);
			if (audioElement) {
				audioElement.pause();
				audioElement.src = '';
				audioElement = undefined;
			}
		};
	});

	function mountFunction() {
		isSmFactor = window.matchMedia('(min-width: 640px)').matches;
		executeUpdateScroll();
	}

	function handleKeyPress(event: KeyboardEvent) {
		if ($notesOpen$ || $dialogOpen$ || $settingsOpen$ || lineInEdit) {
			return;
		}

		const key = (event.key || '')?.toLowerCase();

		if (key === 'delete') {
			const selection = window.getSelection();
			if (selection?.toString().trim() && selection.rangeCount) {
				const range = selection.getRangeAt(0);

				for (let index = 0, { length } = lineElements; index < length; index += 1) {
					const lineElement = lineElements[index];
					const selectedId = lineElement?.getIdIfSelected(range);

					if (selectedId) {
						selectedLineIds.push(selectedId);
					}
				}
			}

			if (selectedLineIds.length) {
				removeLines();
			} else if (event.altKey) {
				removeLastLine();
			}
		} else if (key === 'escape') {
			if (selectedLineIds.length) deselectLines();
			if (miningSelectedIds.size || miningDrag) clearMiningSelection();
		} else if (event.altKey && key === 'a') {
			settingsComponent.handleReset(false);
		} else if (event.altKey && key === 'q') {
			settingsComponent.handleReset(true);
		} else if ((event.ctrlKey || event.metaKey) && key === ' ') {
			void handleTextFeedTimerToggle(false);
		}
	}

	async function handleTextFeedTimerToggle(showClarification = true) {
		const requestedPausedState = !$isPaused$;
		if ($syncTextFeedPauseWithGSMStats$) {
			const updatedPausedState = await setGSMTextIntakePaused(requestedPausedState);
			if (updatedPausedState !== undefined) {
				$isPaused$ = updatedPausedState;
			}
			return;
		}

		$isPaused$ = requestedPausedState;

		if (!showClarification || timerPauseClarificationShown) {
			return;
		}

		timerPauseClarificationShown = true;
		try {
			if (window.localStorage.getItem(TIMER_PAUSE_CLARIFICATION_KEY)) {
				return;
			}
			window.localStorage.setItem(TIMER_PAUSE_CLARIFICATION_KEY, 'true');
		} catch (error) {
			console.warn('Could not save the TextFeed timer clarification state:', error);
		}

		$openDialog$ = {
			icon: mdiInformationOutline,
			message:
				'This play/pause button only controls the TextFeed timer and CPH display. It does not pause GSM stats collection. Use the database button beside it to pause or resume GSM stats collection.',
			showCancel: false,
		};
	}

	async function fetchGSMTextIntakePausedState() {
		const version = miningVersion;
		try {
			const response = await fetch(getGSMEndpoint('/get_ids'));
			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`);
			}
			const data = await response.json();
			if (version === miningVersion && Array.isArray(data.selected_ids)) receiveMiningSelection(data.selected_ids);
			if (typeof data.text_intake_paused === 'boolean') {
				gsmTextIntakePaused = data.text_intake_paused;
			}
		} catch (error) {
			console.error('Failed to fetch GSM stats collection state:', error);
		}
	}

	async function setGSMTextIntakePaused(requestedPausedState: boolean): Promise<boolean | undefined> {
		if (gsmTextIntakeStateRequestPending) {
			return undefined;
		}
		gsmTextIntakeStateRequestPending = true;
		try {
			const response = await fetch(getGSMEndpoint('/set_text_intake_paused'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ paused: requestedPausedState }),
			});
			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`);
			}

			const data = await response.json();
			if (typeof data.paused !== 'boolean') {
				throw new Error('GSM returned an invalid text intake state');
			}
			gsmTextIntakePaused = data.paused;
			return data.paused;
		} catch (error) {
			console.error('Failed to update GSM stats collection state:', error);
			$openDialog$ = {
				type: 'error',
				message: 'Could not update GSM stats collection state.',
				showCancel: false,
			};
			return undefined;
		} finally {
			gsmTextIntakeStateRequestPending = false;
		}
	}

	async function handleGSMTextIntakeToggle() {
		if (gsmTextIntakePaused === undefined) {
			return;
		}
		await setGSMTextIntakePaused(!gsmTextIntakePaused);
	}

	function initializeAudioElement() {
		const createdAudioElement = new Audio();
		audioElement = createdAudioElement;
		createdAudioElement.preload = 'auto';
		createdAudioElement.addEventListener('play', () => {
			lastBrowserAudioStartAt = Date.now();
			browserAudioPlaying = true;
		});
		createdAudioElement.addEventListener('pause', () => {
			browserAudioPlaying = false;
		});
		createdAudioElement.addEventListener('ended', () => {
			browserAudioPlaying = false;
			audioCurrentTime = 0;
		});
		createdAudioElement.addEventListener('timeupdate', () => {
			audioCurrentTime = createdAudioElement.currentTime || 0;
		});
		createdAudioElement.addEventListener('loadedmetadata', () => {
			audioDuration = Number.isFinite(createdAudioElement.duration) ? createdAudioElement.duration : 0;
		});
	}

	function getLineTextById(lineId: string) {
		return $lineData$.find((line) => line.id === lineId)?.text || '';
	}

	function stopBrowserAudio(clearActiveLine = false) {
		if (!audioElement) {
			return;
		}
		audioElement.pause();
		try {
			audioElement.currentTime = 0;
		} catch (_error) {
			// no-op
		}
		browserAudioPlaying = false;
		audioCurrentTime = 0;
		if (clearActiveLine) {
			activeAudioLineId = '';
		}
	}

	async function playBrowserAudioGuarded() {
		if (!audioElement) {
			return;
		}

		const now = Date.now();
		if (now - lastBrowserAudioStartAt < AUDIO_PLAY_START_GUARD_MS) {
			return;
		}
		lastBrowserAudioStartAt = now;
		try {
			await audioElement.play();
		} catch (error) {
			// Allow immediate retry if browser rejects autoplay/start.
			lastBrowserAudioStartAt = 0;
			throw error;
		}
	}

	function handleAudioEvent(payload: Record<string, any>) {
		const eventType = payload?.event;
		if (!eventType) {
			return;
		}
		if (eventType === 'reset_buttons') {
			pendingAudioLineId = '';
			activeAudioLineId = '';
			browserAudioPlaying = false;
			if (audioElement) {
				stopBrowserAudio(true);
			}
			return;
		}

		if (eventType === 'clip_saved' || eventType === 'clip_save_failed') {
			const lineIds: string[] = Array.isArray(payload.line_ids) ? payload.line_ids : [];
			savingClipIds = savingClipIds.filter((id) => !lineIds.includes(id));
			if (eventType === 'clip_saved') {
				void loadSavedClips();
			} else {
				showClipError(`Could not save clip: ${payload.error || 'Unknown error'}`);
			}
			return;
		}

		if (eventType === 'audio_ready') {
			const lineId = payload.line_id || '';
			const audioUrl = payload.audio_url || '';
			if (pendingAudioLineId && lineId !== pendingAudioLineId) {
				return;
			}
			if (!pendingAudioLineId && lineId !== activeAudioLineId) {
				return;
			}
			pendingAudioLineId = '';
			if (!audioUrl || !lineId) {
				return;
			}
			activeAudioLineId = lineId;
			audioWidgetText = getLineTextById(lineId);
			audioWidgetVisible = true;
			void playAudioUrl(getGSMEndpoint(audioUrl), lineId);
			return;
		}

		if (eventType === 'audio_error') {
			const lineId = payload.line_id || '';
			if (pendingAudioLineId && lineId !== pendingAudioLineId) {
				return;
			}
			pendingAudioLineId = '';
			console.error('Audio playback failed:', payload.error || 'Unknown error');
			return;
		}

	}

	async function playAudioUrl(audioUrl: string, lineId: string) {
		if (!audioElement) {
			initializeAudioElement();
		}
		if (!audioElement) {
			return;
		}

		const resolvedUrl = new URL(audioUrl, window.location.href).toString();
		if (audioElement.src !== resolvedUrl) {
			audioElement.src = resolvedUrl;
			audioCurrentTime = 0;
			audioDuration = 0;
		}

		activeAudioLineId = lineId;
		try {
			await playBrowserAudioGuarded();
		} catch (error) {
			console.error('Could not start browser audio playback:', error);
		}
	}

	async function requestAudioForLine(lineId: string) {
		pendingAudioLineId = lineId;
		try {
			const response = await fetch(getGSMEndpoint('/play-audio'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: lineId,
					trim_with_vad: $trimAudioWithVAD$,
					playback_mode: 'browser',
				}),
			});
			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`);
			}
		} catch (error) {
			pendingAudioLineId = '';
			console.error('Error requesting audio playback:', error);
		}
	}

	async function handleAudioToggle(event: CustomEvent<{ lineId: string; text: string }>) {
		const { lineId, text } = event.detail;
		audioWidgetText = text || '';
		if (pendingAudioLineId === lineId) {
			return;
		}

		if (lineId === activeAudioLineId && audioElement && audioElement.src) {
			if (browserAudioPlaying) {
				stopBrowserAudio();
			} else {
				try {
					audioElement.currentTime = 0;
					await playBrowserAudioGuarded();
				} catch (error) {
					console.error('Could not restart browser audio playback:', error);
				}
			}
			return;
		}

		if (audioElement) {
			stopBrowserAudio();
		}

		audioWidgetVisible = true;
		await requestAudioForLine(lineId);
	}

	async function toggleAudioWidgetPlayback() {
		if (!audioElement || !audioElement.src) {
			return;
		}
		if (browserAudioPlaying) {
			stopBrowserAudio();
			return;
		}
		try {
			audioElement.currentTime = 0;
			await playBrowserAudioGuarded();
		} catch (error) {
			console.error('Could not restart audio from widget:', error);
		}
	}

	async function handleVideoTrim(event: CustomEvent<{ lineId: string; text: string }>) {
		const { lineId } = event.detail;
		try {
			const response = await fetch(getGSMEndpoint('/trim-video'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: lineId,
					trim_with_vad: $trimVideoWithVAD$,
					show_in_explorer: true,
				}),
			});
			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`);
			}
		} catch (error) {
			console.error('Error requesting video trim:', error);
		}
	}

	function showClipError(message: string) {
		$openDialog$ = { type: 'error', message, showCancel: false };
	}

	// Clips live on disk, not in this browser's history: saved lines keep their replay buttons
	// and are listed in the Clips view.
	async function loadSavedClips() {
		try {
			savedClips = await fetchSavedClips();
		} catch (error) {
			console.warn('Could not load the saved clips:', error);
		}
	}

	function toggleClipsView() {
		clipsViewOpen = !clipsViewOpen;
		if (clipsViewOpen) {
			void loadSavedClips();
		}
	}

	$: clipByLine = new Map(savedClips.flatMap((clip) => clip.lines.map((line) => [line.id, clip])));
	$: clipLines = savedClips.flatMap((clip) => clip.lines);

	async function handleOpenClipFolder(event: CustomEvent<{ lineId: string }>) {
		const clip = clipByLine.get(event.detail.lineId);
		try {
			const response = await fetch(getGSMEndpoint('/api/clips/open'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: clip?.id }),
			});
			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`);
			}
		} catch (error) {
			showClipError(`Could not open the clip folder: ${getErrorMessage(error)}`);
		}
	}

	async function handleDeleteClip(event: CustomEvent<{ lineId: string }>) {
		const clip = clipByLine.get(event.detail.lineId);
		if (!clip) {
			return;
		}
		try {
			await trashSavedClips([clip]);
		} catch (error) {
			showClipError(`Could not delete clip: ${getErrorMessage(error)}`);
		}
		await loadSavedClips();
	}

	async function handleSaveClip(event: CustomEvent<{ lineId: string }>) {
		const { lineId } = event.detail;
		if (savingClipIds.includes(lineId)) {
			return;
		}
		savingClipIds = [...savingClipIds, lineId];
		try {
			const response = await fetch(getGSMEndpoint('/save-clip'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: lineId }),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw new Error(data.error || `HTTP error: ${response.status}`);
			}
			if (data.already_saved) {
				savingClipIds = savingClipIds.filter((id) => id !== lineId);
				await loadSavedClips();
			}
		} catch (error) {
			savingClipIds = savingClipIds.filter((id) => id !== lineId);
			showClipError(`Could not save clip: ${getErrorMessage(error)}`);
		}
	}

	async function applyTextFeedSessionSync(sync: TextFeedSessionSync) {
		if (!sync.sessionId) {
			return;
		}

		const syncVersion = ++textFeedSessionSyncVersion;
		currentGSMSessionId = sync.sessionId;
		activateRemovedGSMSession(sync.sessionId);
		await yieldToBrowser();
		if (syncVersion !== textFeedSessionSyncVersion) {
			return;
		}

		const { syncedLines, retainedLines, insertionIndex } = buildTextFeedSessionSyncPlan(
			sync,
			$lineData$,
			normalizeLineContent,
			removedGSMLineIds,
		);
		$lineIDs$ = sync.activeIds;
		$timedOutIDs$ = sync.timedOutIds;

		if (!syncedLines.length) {
			$lineData$ = retainedLines;
			$lineData$ = applyMaxLinesAndGetRemainingLineData();
			updateGSMLineStatuses(sync.activeIds, sync.timedOutIds, sync.sessionId);
			return;
		}

		let batchEnd = syncedLines.length;
		let firstRenderedId = '';
		while (batchEnd > 0) {
			const batchStart = Math.max(0, batchEnd - TEXTFEED_SESSION_SYNC_BATCH_SIZE);
			const snapshotBatch = syncedLines.slice(batchStart, batchEnd);
			const { batchLines, remainingLines } = reconcileTextFeedSessionSyncBatch(
				snapshotBatch,
				firstRenderedId ? $lineData$ : retainedLines,
			);

			if (!firstRenderedId) {
				const boundedInsertionIndex = Math.min(insertionIndex, remainingLines.length);
				$lineData$ = [
					...remainingLines.slice(0, boundedInsertionIndex),
					...batchLines,
					...remainingLines.slice(boundedInsertionIndex),
				];
			} else {
				const renderedBlockIndex = remainingLines.findIndex((line) => line.id === firstRenderedId);
				if (renderedBlockIndex < 0) {
					return;
				}
				$lineData$ = [
					...remainingLines.slice(0, renderedBlockIndex),
					...batchLines,
					...remainingLines.slice(renderedBlockIndex),
				];
			}

			for (const line of batchLines) {
				$uniqueLines$.add(line.text);
			}
			firstRenderedId = batchLines[0].id;
			batchEnd = batchStart;

			if (batchEnd > 0) {
				await yieldToBrowser();
				if (syncVersion !== textFeedSessionSyncVersion) {
					return;
				}
			}
		}
		$lineData$ = applyMaxLinesAndGetRemainingLineData();
		updateGSMLineStatuses(sync.activeIds, sync.timedOutIds, sync.sessionId);
	}

	function yieldToBrowser() {
		return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	}

	function loadRemovedGSMLines(): { sessionId: string; ids: string[] } {
		try {
			const storedValue = window.localStorage.getItem(REMOVED_GSM_LINES_STORAGE_KEY);
			if (!storedValue) {
				return { sessionId: '', ids: [] };
			}

			const storedState = JSON.parse(storedValue) as { sessionId?: unknown; ids?: unknown };
			const sessionId = typeof storedState.sessionId === 'string' ? storedState.sessionId : '';
			const ids = Array.isArray(storedState.ids)
				? storedState.ids.filter((id): id is string => typeof id === 'string' && Boolean(id))
				: [];
			return {
				sessionId,
				ids: [...new Set(ids)].slice(-DEFAULT_TEXTFEED_SESSION_SYNC_LINE_LIMIT),
			};
		} catch (error) {
			console.warn('Could not restore removed GSM TextFeed lines:', error);
			return { sessionId: '', ids: [] };
		}
	}

	function persistRemovedGSMLines() {
		try {
			if (!removedGSMSessionId || !removedGSMLineIds.size) {
				window.localStorage.removeItem(REMOVED_GSM_LINES_STORAGE_KEY);
				return;
			}

			window.localStorage.setItem(
				REMOVED_GSM_LINES_STORAGE_KEY,
				JSON.stringify({ sessionId: removedGSMSessionId, ids: [...removedGSMLineIds] }),
			);
		} catch (error) {
			console.warn('Could not save removed GSM TextFeed lines:', error);
		}
	}

	function activateRemovedGSMSession(sessionId: string) {
		if (removedGSMSessionId === sessionId) {
			return;
		}

		removedGSMSessionId = sessionId;
		removedGSMLineIds = new Set();
		persistRemovedGSMLines();
	}

	function isRemovedGSMLine(id: string, sessionId: string) {
		return sessionId === removedGSMSessionId && removedGSMLineIds.has(id);
	}

	function rememberRemovedGSMLines(lines: LineItem[]) {
		if (!currentGSMSessionId) {
			return;
		}

		let changed = false;
		for (const line of lines) {
			if (line.gsmSessionId === currentGSMSessionId && !removedGSMLineIds.has(line.id)) {
				removedGSMLineIds.add(line.id);
				changed = true;
			}
		}

		while (removedGSMLineIds.size > DEFAULT_TEXTFEED_SESSION_SYNC_LINE_LIMIT) {
			const oldestId = removedGSMLineIds.values().next().value;
			if (!oldestId) {
				break;
			}
			removedGSMLineIds.delete(oldestId);
		}

		if (changed) {
			// Do not let a yielded snapshot batch repopulate the display after a
			// deletion or a clear-lines action performed while it was rendering.
			textFeedSessionSyncVersion += 1;
			persistRemovedGSMLines();
		}
	}

	function forgetRemovedGSMLines(lines: LineItem[]) {
		const changed = lines.reduce((didChange, line) => removedGSMLineIds.delete(line.id) || didChange, false);
		if (changed) {
			persistRemovedGSMLines();
		}
	}

	function updateGSMLineStatuses(ids: string[], timedOutIds: string[], sessionId: string | undefined) {
		const activeIds = new Set(ids);
		const expiredIds = new Set(timedOutIds);
		let changed = false;
		const nextLineData = $lineData$.map((line) => {
			if (line.gsmStatus === 'external') {
				return line;
			}

			let gsmStatus = line.gsmStatus;
			let gsmSessionId = line.gsmSessionId;
			if (sessionId && gsmSessionId && gsmSessionId !== sessionId) {
				gsmStatus = 'previous_session';
			} else if (activeIds.has(line.id)) {
				gsmStatus = 'active';
				gsmSessionId ||= sessionId;
			} else if (expiredIds.has(line.id)) {
				gsmStatus = 'timed_out';
				gsmSessionId ||= sessionId;
			} else if (!gsmStatus) {
				// Legacy persisted lines predate explicit source/session metadata.
				gsmStatus = 'previous_session';
			}

			if (gsmStatus === line.gsmStatus && gsmSessionId === line.gsmSessionId) {
				return line;
			}
			changed = true;
			return { ...line, gsmStatus, gsmSessionId };
		});

		if (changed) {
			$lineData$ = nextLineData;
		}
	}

	function resetCheckBoxes() {
		const staleIds = new Set([...miningSelectedIds, ...pendingMiningUpdates.keys(), ...inFlightMiningUpdates.map(({ id }) => id)]);
		finishMiningSelection(false);
		miningVersion += 1;
		miningResetVersion += 1;
		pendingMiningUpdates.clear();
		miningSelectedIds = new Set();
		miningAnchor = '';
		miningError = '';
		// A request already on the wire may arrive after the authoritative reset.
		// Follow it with explicit clears so it cannot leave a hidden selection in GSM.
		if (inFlightMiningUpdates.length) {
			for (const id of staleIds) pendingMiningUpdates.set(id, false);
		}
	}

	async function undoLastAction() {
		if (!$actionHistory$.length) {
			return;
		}

		const linesToRevert = $actionHistory$.pop();
		if (!linesToRevert) {
			return;
		}

		const restoredLines: LineItem[] = [];
		let lineToRevert = linesToRevert.pop();

		while (lineToRevert) {
			const text = transformLine(lineToRevert.text, false);

			if (text) {
				const { id } = lineToRevert;
				const index = lineToRevert.index ?? $lineData$.length;
				const existingIndex = $lineData$.findIndex((line) => line.id === id);
				restoredLines.push(lineToRevert);

				if (existingIndex >= 0) {
					$lineData$[existingIndex] = { ...lineToRevert, id, text };
				} else if (index > $lineData$.length - 1) {
					$lineData$.push({ ...lineToRevert, id, text });
				} else {
					$lineData$.splice(index, 0, { ...lineToRevert, id, text });
				}
			}

			lineToRevert = linesToRevert.pop();
		}

		forgetRemovedGSMLines(restoredLines);
		await tick();

		$lineData$ = applyEqualLineStartMerge(applyMaxLinesAndGetRemainingLineData());
		$actionHistory$ = $actionHistory$;
	}

	function removeLastLine() {
		if (!$lineData$.length) {
			return;
		}

		const [removedLine] = $lineData$.splice($lineData$.length - 1, 1);

		rememberRemovedGSMLines([removedLine]);
		selectedLineIds = selectedLineIds.filter((selectedLineId) => selectedLineId !== removedLine.id);
		$lineData$ = $lineData$;
		$actionHistory$ = [...$actionHistory$, [{ ...removedLine, index: $lineData$.length }]];

		$uniqueLines$.delete(removedLine.text);
	}

	function removeLines() {
		const linesToDelete = new Set(selectedLineIds);
		const newActionHistory: LineItem[] = [];

		$lineData$ = $lineData$.filter((oldLine, index) => {
			const hasLine = linesToDelete.has(oldLine.id);

			linesToDelete.delete(oldLine.id);

			if (hasLine) {
				newActionHistory.push({ ...oldLine, index: index - newActionHistory.length });
				$uniqueLines$.delete(oldLine.text);
			}

			return !hasLine;
		});

		selectedLineIds = linesToDelete.size ? [...linesToDelete] : [];

		if (newActionHistory.length) {
			rememberRemovedGSMLines(newActionHistory);
			$actionHistory$ = [...$actionHistory$, newActionHistory];
		}
	}

	function deselectLines() {
		for (let index = 0, { length } = lineElements; index < length; index += 1) {
			lineElements[index]?.deselect();
		}

		selectedLineIds = [];
	}

	async function handlePipAction() {
		if (pipWindow) {
			return pipWindow.close();
		}

		pipWindow = await window.documentPictureInPicture
			.requestWindow(
				$lastPipHeight$ > 0 && $lastPipWidth$ > 0
					? { height: $lastPipHeight$, width: $lastPipWidth$, preferInitialWindowPlacement: false }
					: { preferInitialWindowPlacement: false },
			)
			.catch(({ message }) => {
				$openDialog$ = {
					message: `Error opening floating window: ${message}`,
					showCancel: false,
				};

				return undefined;
			});

		if (!pipWindow) {
			return;
		}
		const activePipWindow = pipWindow;

		activePipWindow.document.body.appendChild(pipContainer);

		activePipWindow.addEventListener('pagehide', onPipHide, { once: true });
		activePipWindow.addEventListener('resize', onPipResize, false);
		activePipWindow.addEventListener('blur', onPipFocusBlur, false);
		activePipWindow.addEventListener('focus', onPipFocusBlur, false);

		[...document.styleSheets].forEach((styleSheet) => {
			// applyCustomCSS keeps the user sheets live in the pip window
			if (
				styleSheet.ownerNode instanceof Element &&
				['user-css', 'user-css-url'].includes(styleSheet.ownerNode.id)
			) {
				return;
			}

			try {
				const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
				const style = document.createElement('style');

				style.textContent = cssRules;
				activePipWindow.document.head.appendChild(style);
			} catch (_error) {
				const link = document.createElement('link');

				link.rel = 'stylesheet';
				link.type = styleSheet.type;
				link.media = styleSheet.media.toString();
				if (styleSheet.href) {
					link.href = styleSheet.href;
				}
				activePipWindow.document.head.appendChild(link);
			}
		});
	}

	function onPipHide() {
		const closingPipWindow = pipWindow;
		if (!closingPipWindow) {
			return;
		}
		updatePipDimensions();

		closingPipWindow.removeEventListener('resize', onPipResize, false);
		closingPipWindow.removeEventListener('blur', onPipFocusBlur, false);
		closingPipWindow.removeEventListener('focus', onPipFocusBlur, false);

		hasPipFocus = false;
		pipWindow = undefined;
	}

	function onPipResize() {
		window.clearTimeout(pipResizeTimeout);

		pipResizeTimeout = window.setTimeout(updatePipDimensions, 500);
	}

	function updatePipDimensions() {
		if (!pipWindow) {
			return;
		}

		$lastPipHeight$ = pipWindow.document.body.clientHeight;
		$lastPipWidth$ = pipWindow.document.body.clientWidth;
	}

	function onPipFocusBlur(event: Event) {
		hasPipFocus = event.type === 'focus';
	}

	function onAfkBlur({ detail: isAfk }: CustomEvent<boolean>) {
		applyAfkBlur(document, isAfk);

		if (pipWindow) {
			applyAfkBlur(pipWindow.document, isAfk);
		}
	}

	function executeUpdateScroll() {
		updateScroll(window, lineContainer, $reverseLineOrder$, $displayVertical$);

		if (pipWindow) {
			updateScroll(pipWindow, pipContainer, $reverseLineOrder$, false);
		}
	}

	function scrollToNewest() {
		updateScroll(window, lineContainer, $reverseLineOrder$, $displayVertical$, 'smooth');
	}

	function handleMissedLine() {
		clearTimeout($flashOnPauseTimeout$);

		if ($theme$ === Theme.GARDEN) {
			settingsContainer.classList.add('bg-base-200');
			settingsContainer.classList.remove('bg-base-100');
			document.body.classList.add('bg-base-200');
		}

		document.body.classList.add('animate-[pulse_0.5s_cubic-bezier(0.4,0,0.6,1)_1]');

		$flashOnPauseTimeout$ = window.setTimeout(() => {
			if ($theme$ === Theme.GARDEN) {
				settingsContainer.classList.add('bg-base-100');
				settingsContainer.classList.remove('bg-base-200');
				document.body.classList.remove('bg-base-200');
			}

			document.body.classList.remove('animate-[pulse_0.5s_cubic-bezier(0.4,0,0.6,1)_1]');
		}, 500);
	}

	function normalizeLineContent(text: string, useReplacements = true) {
		const textToAppend = useReplacements ? applyReplacements(text, $enabledReplacements$) : text;
		let lineToAppend = $removeAllWhitespace$ ? textToAppend.replace(/\s/gm, '').trim() : textToAppend;

		if ($filterNonCJKLines$ && !lineToAppend.match(cjkCharacters)) {
			lineToAppend = '';
		}

		return lineToAppend || undefined;
	}

	function transformLine(text: string, useReplacements = true, enforceDuplicateFilters = true) {
		const lineToAppend = normalizeLineContent(text, useReplacements);
		let canAppend = Boolean(lineToAppend);

		if (lineToAppend && enforceDuplicateFilters && $preventGlobalDuplicate$) {
			canAppend = !$uniqueLines$.has(lineToAppend);
			$uniqueLines$.add(lineToAppend);
		} else if (lineToAppend && enforceDuplicateFilters && $preventLastDuplicate$ && $lineData$.length) {
			canAppend = $lineData$.slice(-$preventLastDuplicate$).every((line) => line.text !== lineToAppend);
		}

		return canAppend ? lineToAppend : undefined;
	}

	function handleLineEdit(event: CustomEvent<LineItemEditEvent>) {
		const { inEdit, data } = event.detail;

		if (data && data.originalText !== data.newText) {
			const text = transformLine(data.newText);

			if (text) {
				$lineData$[data.lineIndex] = {
					...data.line,
					text,
				};
				$actionHistory$ = [...$actionHistory$, [{ ...data.line, index: data.lineIndex }]];
				$uniqueLines$.delete(data.originalText);
				$uniqueLines$.add(text);
			} else {
				tick().then(
					() =>
						($lineData$[data.lineIndex] = {
							...data.line,
							text: data.originalText,
						}),
				);
			}
		}

		lineInEdit = inEdit;
	}

	function applyMaxLinesAndGetRemainingLineData(diffMod = 0) {
		const linesToRemove = $maxLines$ ? Math.min($lineData$.length, $lineData$.length - $maxLines$ + diffMod) : 0;
		if (linesToRemove <= 0) {
			return $lineData$;
		}

		const oldLinesToRemove = new Set($lineData$.slice(0, linesToRemove).map((line) => line.id));
		for (let index = 0; index < linesToRemove; index += 1) {
			$uniqueLines$.delete($lineData$[index].text);
		}

		selectedLineIds = selectedLineIds.filter((selectedLineId) => !oldLinesToRemove.has(selectedLineId));

		return $lineData$.slice(linesToRemove);
	}

	function updateLineData(executeUpdate: boolean) {
		if (!executeUpdate) {
			return;
		}

		$showSpinner$ = true;

		try {
			for (let index = 0, { length } = $lineData$; index < length; index += 1) {
				const line = $lineData$[index];
				const newText = transformLine(line.text);

				if (newText && newText !== line.text) {
					$uniqueLines$.delete(line.text);

					$lineData$[index] = { ...line, text: newText };
				}
			}

			$openDialog$ = {
				message: `Operation executed`,
				showCancel: false,
			};
		} catch (error) {
			$openDialog$ = {
				type: 'error',
				message: `An Error occured: ${getErrorMessage(error)}`,
				showCancel: false,
			};
		}

		$lineData$ = applyEqualLineStartMerge(applyMaxLinesAndGetRemainingLineData());

		$showSpinner$ = false;
	}

	function applyEqualLineStartMerge(currentLineData: LineItem[]) {
		if (!$mergeEqualLineStarts$ || currentLineData.length < 2) {
			return currentLineData;
		}

		const lastIndex = currentLineData.length - 1;
		const comparisonIndex = lastIndex - 1;
		const lastLine = currentLineData[lastIndex];
		const comparisonLine = currentLineData[comparisonIndex].text;

		if (lastLine.text.startsWith(comparisonLine)) {
			$uniqueLines$.delete(comparisonLine);

			selectedLineIds = selectedLineIds.filter(
				(selectedLineId) => selectedLineId !== currentLineData[comparisonIndex].id,
			);

			currentLineData.splice(comparisonIndex, 2, lastLine);
		}

		return currentLineData;
	}

	// Non-Anki / Migaku helper: build media folders for the selected (or last) line without an Anki card.
	async function handleCreateMedia() {
		try {
			const response = await fetch(getGSMEndpoint('/create-media'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ids: selectedLineIds,
					trim_with_vad: $trimAudioWithVAD$,
				}),
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				$openDialog$ = {
					type: 'error',
					message: data.error || `Failed to create media (HTTP ${response.status})`,
					showCancel: false,
				};
			}
		} catch (error) {
			console.error('Error creating media:', error);
		}
	}

	let numberOfLinesToTranslate = '';

	async function handleTranslate() {
		if (!numberOfLinesToTranslate.trim()) return;

		try {

			let ids = $lineIDs$;
			if (Number(numberOfLinesToTranslate) < ids.length) {
				ids = ids.slice(-Number(numberOfLinesToTranslate));
			}
			
			const response = await fetch(getGSMEndpoint('/translate-multiple'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ ids }),
			});
			
			if (response.ok) {
				const result = await response.text();
				// Add the translation result as a normal websocket event without adding to lineIDs
				newLine$.next([result, LineType.TL, '']);
			} else {
				const data = await response.json().catch(() => ({}));
				$openDialog$ = { type: 'error', message: data.error || 'Translation failed. Check AI / Translation settings.', showCancel: false };
			}
		} catch (error) {
			console.error('Translation failed:', error);
			$openDialog$ = { type: 'error', message: 'Could not reach GSM. Check that it is running and retry.', showCancel: false };
		}
	}
</script>

<svelte:window on:keyup={handleKeyPress} />

{$handleLine$ ?? ''}
{$handleTextFeedSessionSync$ ?? ''}
{$pasteHandler$ ?? ''}
{$copyBlocker$ ?? ''}
{$resizeHandler$ ?? ''}
{$scrollHandler$ ?? ''}

{#if $showSpinner$}
	<Spinner />
{/if}

<DialogManager />

<header class="fixed top-0 right-0 flex justify-end items-center p-2 bg-base-100" bind:this={settingsContainer}>
	<Stats on:afkBlur={onAfkBlur} />
	{#if $websocketUrl$}
		<SocketConnector />
	{/if}
	{#if $secondaryWebsocketUrl$}
		<SocketConnector isPrimary={false} />
	{/if}
	{#if $isPaused$}
		<div
			role="button"
			title="Continue"
			class="mr-1 animate-[pulse_1.25s_cubic-bezier(0.4,0,0.6,1)_infinite] hover:text-primary sm:mr-2"
		>
			<Icon path={mdiPlay} width={iconSize} height={iconSize} on:click={() => void handleTextFeedTimerToggle()} />
		</div>
	{:else}
		<div role="button" title="Pause" class="mr-1 hover:text-primary sm:mr-2">
			<Icon path={mdiPause} width={iconSize} height={iconSize} on:click={() => void handleTextFeedTimerToggle()} />
		</div>
	{/if}
	<div
		role="button"
		title={gsmTextIntakePaused === undefined
			? 'Checking GSM stats collection status…'
			: gsmTextIntakePaused
				? 'Resume GSM stats collection'
				: 'Pause GSM stats collection'}
		class="mr-1 hover:text-primary sm:mr-2"
		class:animate-[pulse_1.25s_cubic-bezier(0.4,0,0.6,1)_infinite]={gsmTextIntakePaused === true}
		class:opacity-50={gsmTextIntakePaused === undefined || gsmTextIntakeStateRequestPending}
		class:cursor-not-allowed={gsmTextIntakePaused === undefined || gsmTextIntakeStateRequestPending}
	>
		<Icon
			path={gsmTextIntakePaused ? mdiDatabaseOff : mdiDatabase}
			width={iconSize}
			height={iconSize}
			on:click={handleGSMTextIntakeToggle}
		/>
	</div>
	<div
		role="button"
		title="Delete last Line"
		class="mr-1 hover:text-primary sm:mr-2"
		class:opacity-50={!$lineData$.length}
		class:cursor-not-allowed={!$lineData$.length}
		class:hover:text-primary={$lineData$.length}
	>
		<Icon path={mdiDeleteForever} width={iconSize} height={iconSize} on:click={removeLastLine} />
	</div>
	<div
		role="button"
		title="Undo last Action"
		class="mr-1 hover:text-primary sm:mr-2"
		class:opacity-50={!$actionHistory$.length}
		class:cursor-not-allowed={!$actionHistory$.length}
		class:hover:text-primary={$actionHistory$.length}
	>
		<Icon path={mdiArrowULeftTop} width={iconSize} height={iconSize} on:click={undoLastAction} />
	</div>
	{#if selectedLineIds.length}
		<div role="button" title="Remove selected Lines" class="mr-1 hover:text-primary sm:mr-2">
			<Icon path={mdiDelete} width={iconSize} height={iconSize} on:click={removeLines} />
		</div>
		<div role="button" title="Deselect Lines" class="mr-1 hover:text-primary sm:mr-2">
			<Icon path={mdiCancel} width={iconSize} height={iconSize} on:click={deselectLines} />
		</div>
	{/if}
	<div role="button" title="Open Notes" class="mr-1 hover:text-primary sm:mr-2">
		<Icon path={mdiNoteEdit} width={iconSize} height={iconSize} on:click={() => ($notesOpen$ = true)} />
	</div>
	<div
		role="button"
		title="Create media folder (no Anki card) for selected or last line"
		class="mr-1 hover:text-primary sm:mr-2"
	>
		<Icon path={mdiFolderMultipleImage} width={iconSize} height={iconSize} on:click={handleCreateMedia} />
	</div>
	{#if pipAvailable}
		<div
			role="button"
			class="mr-1 hover:text-primary sm:mr-2"
			title={pipWindow ? 'Close Floating Window' : 'Open Floating Window'}
		>
			<Icon
				width={iconSize}
				height={iconSize}
				path={pipWindow ? mdiWindowMaximize : mdiWindowRestore}
				on:click={handlePipAction}
			/>
		</div>
	{/if}
	<div
		role="button"
		class="mr-1 hover:text-primary sm:mr-2"
		class:text-primary={clipsViewOpen}
		title={clipsViewOpen ? 'Back to TextFeed' : 'Show Saved Clips'}
	>
		<Icon path={mdiContentSaveAll} width={iconSize} height={iconSize} on:click={toggleClipsView} />
	</div>
	<div
		role="button"
		class="mr-1 hover:text-primary sm:mr-2"
		title="Open Statistics Page"
	>
		<Icon
		path={mdiChartBar}
		width={iconSize}
		height={iconSize}
		on:click={() => window.open('/overview', '_blank')}
		/>
	</div>
	
	<Icon
		class="cursor-pointer mr-1 hover:text-primary md:mr-2"
		path={mdiCog}
		width={iconSize}
		height={iconSize}
		bind:element={settingsElement}
		on:click={() => ($settingsOpen$ = !$settingsOpen$)}
	/>
	<Settings
		{settingsElement}
		{pipAvailable}
		bind:selectedLineIds
		bind:this={settingsComponent}
		on:applyReplacements={() => updateLineData(!!$enabledReplacements$.length)}
		on:layoutChange={executeUpdateScroll}
		on:linesRemoved={({ detail }) => rememberRemovedGSMLines(detail)}
		on:maxLinesChange={() => ($lineData$ = applyMaxLinesAndGetRemainingLineData())}
		on:savedClipsChanged={loadSavedClips}
	/>
	<Presets isQuickSwitch={true} on:layoutChange={executeUpdateScroll} />
</header>
<main
	class="flex flex-col flex-1 break-all px-4 w-full h-full overflow-auto"
	class:py-16={!$displayVertical$}
	class:py-8={$displayVertical$}
	class:opacity-50={$notesOpen$}
	class:selection-dragging={!!miningDrag?.mining}
	class:flex-col-reverse={$reverseLineOrder$}
	style:font-size={`${$fontSize$}px`}
	style:font-family={$onlineFont$ !== OnlineFont.OFF ? $onlineFont$ : undefined}
	style:writing-mode={$displayVertical$ ? 'vertical-rl' : 'horizontal-tb'}
	bind:this={lineContainer}
>
	{@html newLineCharacter}
	{#if clipsViewOpen}
		<h2 class="my-4 text-2xl font-semibold select-none">{describeSavedClips(savedClips, 'Saved Clip')}</h2>
		{#each clipLines as line, index (line.id)}
			<Line
				{line}
				{index}
				isLast={clipLines.length - 1 === index}
				miningSelected={miningSelectedIds.has(line.id)}
				on:miningStart={beginMiningSelection}
				on:miningToggle={toggleMiningSelection}
				on:miningClick={clickMiningRow}
				audioLineId={activeAudioLineId}
				audioIsPlaying={browserAudioPlaying}
				audioPendingLineId={pendingAudioLineId}
				on:audioToggle={handleAudioToggle}
				on:videoTrim={handleVideoTrim}
				on:deleteClip={handleDeleteClip}
				on:openClipFolder={handleOpenClipFolder}
				isClipSaved
				clipSizeBytes={clipByLine.get(line.id)?.size_bytes}
			/>
		{/each}
	{:else}
		{#each $lineData$ as line, index (line.id)}
			<Line
				{line}
				{index}
				isLast={$lineData$.length - 1 === index}
				miningSelected={miningSelectedIds.has(line.id)}
				on:miningStart={beginMiningSelection}
				on:miningToggle={toggleMiningSelection}
				on:miningClick={clickMiningRow}
				audioLineId={activeAudioLineId}
				audioIsPlaying={browserAudioPlaying}
				audioPendingLineId={pendingAudioLineId}
				bind:this={lineElements[index]}
				on:selected={({ detail }) => {
					selectedLineIds = [...selectedLineIds, detail];
				}}
				on:deselected={({ detail }) => {
					selectedLineIds = selectedLineIds.filter((selectedLineId) => selectedLineId !== detail);
				}}
				on:edit={handleLineEdit}
				on:audioToggle={handleAudioToggle}
				on:videoTrim={handleVideoTrim}
				on:saveClip={handleSaveClip}
				on:deleteClip={handleDeleteClip}
				on:openClipFolder={handleOpenClipFolder}
				isSavingClip={savingClipIds.includes(line.id)}
				isClipSaved={clipByLine.has(line.id)}
				clipSizeBytes={clipByLine.get(line.id)?.size_bytes}
			/>
		{/each}
	{/if}
	
	
</main>

<div class="reader-footer">
{#if miningSelectedIds.size || miningSaving || miningError}
	<aside class="mining-toolbar" aria-label="Mining selection" aria-busy={miningSaving}>
		<span class="mining-summary" role="status">
			{#if miningSelectedIds.size}
				Create card with <a href="https://docs.gamesentenceminer.com/docs/getting-started/yomitan-anki/" target="_blank" rel="noopener noreferrer">Yomitan</a> to mine {miningSelectedIds.size} {miningSelectedIds.size === 1 ? 'line' : 'lines'}
			{:else}
				{miningSaving ? 'Saving selection…' : 'No lines selected'}
			{/if}
		</span>
		{#if miningError}<span class="mining-error" role="alert">{miningError}</span><button type="button" on:click={saveMiningSelection}>Retry</button>{/if}
		<button type="button" class="mining-clear" title="Clear selection (Esc)" on:click={clearMiningSelection}>Clear</button>
	</aside>
{/if}

{#if showScrollToNewest}
	<div transition:fade={{ duration: 150 }}>
		<button
			class="flex items-center gap-1 rounded-full border border-base-content/20 bg-base-100/95 py-1.5 pl-2 pr-3 text-xs shadow-lg backdrop-blur transition-colors hover:text-primary"
			on:click={scrollToNewest}
			title="Jump to newest line"
		>
			<Icon path={newestIconPath} width="1rem" height="1rem" />
			<span>{newLinesBelow > 0 ? `${newLinesBelow > 99 ? '99+' : newLinesBelow} new` : 'Newest'}</span>
		</button>
	</div>
{/if}

</div>
<!-- Small translate textbox positioned at bottom right -->
<div class="fixed bottom-2 right-2 z-50">
	<input
		type="text"
		bind:value={numberOfLinesToTranslate}
		on:keydown={(e) => e.key === 'Enter' && handleTranslate()}
		placeholder="TL"
		class="w-8 h-6 text-xs p-1 border border-gray-300 rounded text-center bg-base-100"
		title="Press Enter to translate a number of lines"
	/>
</div>

{#if audioWidgetVisible}
	<div class="fixed bottom-2 left-2 z-50 min-w-[240px] max-w-[360px] rounded-md border border-base-content/20 bg-base-100/95 px-3 py-2 shadow-lg">
		<div class="flex items-center gap-2">
			<Icon path={mdiVolumeHigh} width="1rem" height="1rem" />
			<div class="truncate text-xs" title={audioWidgetText || 'Audio playback'}>
				{audioWidgetText || 'Audio playback'}
			</div>
			<button class="ml-auto rounded border border-base-content/20 px-2 py-1 text-xs" on:click={toggleAudioWidgetPlayback}>
				{browserAudioPlaying ? 'Stop' : 'Replay'}
			</button>
		</div>
		<div class="mt-2 h-1.5 w-full rounded bg-base-300">
			<div
				class="h-full rounded bg-primary transition-[width] duration-100"
				style:width={`${audioProgressPercent}%`}
			></div>
		</div>
	</div>
{/if}

{#if $notesOpen$}
	<div
		class="bg-base-200 fixed top-0 right-0 z-[60] flex h-full w-full max-w-3xl flex-col justify-between"
		in:fly|local={{ x: 100, duration: 100, easing: quintInOut }}
	>
		<Notes />
	</div>
{/if}
<div
	id="pip-container"
	class="flex flex-col flex-1 flex flex-col break-all px-4 w-full h-full overflow-auto"
	class:flex-col-reverse={$reverseLineOrder$}
	class:hidden={!pipWindow}
	class:selection-dragging={!!miningDrag?.mining}
	style:font-size={`${$fontSize$}px`}
	style:font-family={$onlineFont$ !== OnlineFont.OFF ? $onlineFont$ : undefined}
	bind:this={pipContainer}
>
	{#if pipWindow}
		{#each pipLines as line, index (line.id)}
			<Line
				{line}
				{index}
				{pipWindow}
				miningSelected={miningSelectedIds.has(line.id)}
				on:miningStart={beginMiningSelection}
				on:miningToggle={toggleMiningSelection}
				on:miningClick={clickMiningRow}
				isLast={pipLines.length - 1 === index}
				audioLineId={activeAudioLineId}
				audioIsPlaying={browserAudioPlaying}
				audioPendingLineId={pendingAudioLineId}
				on:audioToggle={handleAudioToggle}
				on:videoTrim={handleVideoTrim}
				on:saveClip={handleSaveClip}
				on:deleteClip={handleDeleteClip}
				on:openClipFolder={handleOpenClipFolder}
				isSavingClip={savingClipIds.includes(line.id)}
				isClipSaved={clipByLine.has(line.id)}
				clipSizeBytes={clipByLine.get(line.id)?.size_bytes}
			/>
		{/each}
	{/if}
</div>
<style>
	.reader-footer {
		position: fixed;
		z-index: 50;
		bottom: 18px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column-reverse;
		align-items: center;
		gap: 10px;
		width: max-content;
		max-width: calc(100vw - 24px);
	}
	.mining-toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
		max-width: calc(100vw - 24px);
		padding: 9px 12px;
		border: 1px solid color-mix(in srgb, var(--color-primary) 25%, transparent);
		border-radius: 12px;
		background: var(--color-base-200);
		color: var(--color-base-content);
		box-shadow: 0 6px 28px rgb(0 0 0 / 18%);
		font: 12px/1.4 system-ui, sans-serif;
		writing-mode: horizontal-tb;
	}
	.mining-summary { white-space: nowrap; }
	.mining-summary a { color: color-mix(in srgb, var(--color-primary) 45%, var(--color-base-content)); text-decoration: underline; text-underline-offset: 2px; }
	.mining-toolbar button { padding: 4px 7px; border: 0; border-radius: 5px; background: transparent; color: var(--color-primary); cursor: pointer; font: inherit; }
	.mining-toolbar button:hover { background: color-mix(in srgb, var(--color-primary) 9%, transparent); }
	.mining-toolbar button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
	.mining-error { color: var(--color-error); }
	:global(.selection-dragging .line-body) { user-select: none; }
	@media (max-width: 640px) {
		.reader-footer { bottom: 10px; }
		.mining-toolbar { gap: 7px; flex-wrap: wrap; }
	}
</style>
