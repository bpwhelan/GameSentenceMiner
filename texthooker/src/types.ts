export enum Theme {
	LIGHT = 'light',
	DARK = 'dark',
	CUPCAKE = 'cupcake',
	BUMBLEBEE = 'bumblebee',
	EMERALD = 'emerald',
	CORPORATE = 'corporate',
	SYNTHWAVE = 'synthwave',
	RETRO = 'retro',
	CYBERPUNK = 'cyberpunk',
	VALENTINE = 'valentine',
	HALLOWEEN = 'halloween',
	GARDEN = 'garden',
	FOREST = 'forest',
	AQUA = 'aqua',
	LOFI = 'lofi',
	PASTEL = 'pastel',
	FANTASY = 'fantasy',
	WIREFRAME = 'wireframe',
	BLACK = 'black',
	LUXURY = 'luxury',
	DRACULA = 'dracula',
	CMYK = 'cmyk',
	AUTUMN = 'autumn',
	BUSINESS = 'business',
	ACID = 'acid',
	LEMONADE = 'lemonade',
	NIGHT = 'night',
	COFFEE = 'coffee',
	WINTER = 'winter',
}

export enum OnlineFont {
	OFF = 'Off',
	NOTO = 'Noto Serif JP',
	KLEE = 'Klee One',
	SHIPPORI = 'Shippori Mincho',
	ACKAISYO = 'Ackaisyo',
	CINECAPTION226 = 'CineCaption226',
}

export interface Settings {
	theme$: string;
	replacements$: ReplacementItem[];
	windowTitle$: string;
	websocketUrl$: string;
	secondaryWebsocketUrl$: string;
	fontSize$: number;
	characterMilestone$: number;
	onlineFont$: string;
	preventLastDuplicate$: number;
	maxLines$: number;
	maxPipLines$: number;
	afkTimer$: number;
	adjustTimerOnAfk$: boolean;
	enableExternalClipboardMonitor$: boolean;
	showPresetQuickSwitch$: boolean;
	skipResetConfirmations$: boolean;
	persistStats$: boolean;
	persistNotes$: boolean;
	persistLines$: boolean;
	persistActionHistory$: boolean;
	enablePaste$: boolean;
	blockCopyOnPage$: boolean;
	allowPasteDuringPause$: boolean;
	allowNewLineDuringPause$: boolean;
	autoStartTimerDuringPausePaste$: boolean;
	autoStartTimerDuringPause$: boolean;
	preventGlobalDuplicate$: boolean;
	mergeEqualLineStarts$: boolean;
	filterNonCJKLines: boolean;
	flashOnMissedLine$: boolean;
	displayVertical$: boolean;
	reverseLineOrder$: boolean;
	preserveWhitespace$: boolean;
	removeAllWhitespace$: boolean;
	showTimer$: boolean;
	showSpeed$: boolean;
	showCharacterCount$: boolean;
	showLineCount$: boolean;
	blurStats$: boolean;
	enableLineAnimation$: boolean;
	enableAfkBlur$: boolean;
	enableAfkBlurRestart$: boolean;
	continuousReconnect$: boolean;
	showConnectionErrors$: boolean;
	customCSS$: string;
	autoTranslateLines$: boolean;
	blurAutoTranslatedLines$: boolean;
}

export interface ExportedData {
	'bannou-texthooker-timeValue': number;
	'bannou-texthooker-userNotes': string;
	'bannou-texthooker-lineData': LineItem[];
	'bannou-texthooker-actionHistory': LineItem[][];
}

export interface ExportedSettings {
	currentSettings: Settings;
	settingPresets: SettingPreset[];
	lastSettingsPreset: string;
}

export interface ReplacementItem {
	pattern: string;
	replaces: string;
	flags: string[];
	enabled: boolean;
}

export interface SettingPreset {
	name: string;
	settings: Settings;
}

export interface DialogResult<T = undefined> {
	canceled: boolean;
	data: T;
}

export enum LineType {
	SOCKET = 'socket',
	PASTE = 'paste',
	EXTERNAL = 'external',
	EDIT = 'edit',
	UNDO = 'undo',
	RESETCHECKBOXES = 'reset_checkboxes',
	TL = 'tl',
}

export interface LineItem {
	id: string;
	text: string;
	index?: number;
	translation?: string;
	blurTranslation?: boolean;
}

export interface LineItemEditEvent {
	inEdit: boolean;
	data?: LineItemEditData;
}

export interface LineItemEditData {
	originalText: string;
	newText: string;
	lineIndex: number;
	line: LineItem;
}
