// Shared browser-safe picker policy. No Node or OBS connection is required.
const getObsWindowTitle = (name: string) => name.split(':').slice(1).join(':').trim() || name.trim();

interface WindowFilter {
    exeName?: string; // Executable name (e.g., "Code.exe", "cmd.exe")
    windowClass?: string; // Window class (e.g., "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS")
    titlePattern?: string | RegExp; // Title pattern (exact match or regex)
    // If multiple properties are specified, ALL must match (AND logic)
}

/**
 * List of windows to filter out from the window list.
 * Can filter by exe name, window class, or window title.
 * If multiple properties are specified in a single filter, ALL must match (AND logic).
 * MANY OF THESE ARE FOR ME, AND MAY NOT BE RELEVANT TO OTHER USERS. THIS IS NOT AN EXHAUSTIVE LIST.
 */
const WINDOW_FILTERS: WindowFilter[] = [
    // Developer tools and IDEs
    { exeName: 'Code.exe' }, // Visual Studio Code
    // System tools
    { exeName: 'cmd.exe' },
    { windowClass: 'ConsoleWindowClass' },
    { windowClass: 'CASCADIA_HOSTING_WINDOW_CLASS' },
    // Audio editors
    { exeName: 'ocenaudio.exe' },
    // Specific applications
    { exeName: 'SKIF.exe' }, // Special K
    { exeName: 'EpicGamesLauncher.exe' }, // Epic Games Launcher
    { titlePattern: 'Epic Games Launcher' }, // Epic Games Launcher by title
    { exeName: 'LunaTranslator.exe' }, // LunaTranslator
    { titlePattern: 'LunaTranslator' }, // LunaTranslator by title
    // Windows Search
    { exeName: 'SearchHost.exe' }, // Windows Search Host
    { titlePattern: 'Search' }, // Windows Search by title
    // ShareX
    { exeName: 'ShareX.exe' }, // ShareX
    { titlePattern: 'ShareX' }, // ShareX by title
    // Flydigi Space Station (must match both exe and title)
    { exeName: 'Flydigi Space Station.exe' }, // Flydigi only
    // Anki (must match both pythonw.exe AND have Anki in title)
    { exeName: 'pythonw.exe', titlePattern: '- Anki' }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: 'Browse (' }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: /^Edit$/ }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: 'Preview' }, // Anki only
    // Exact title match
    { exeName: 'GameSentenceMiner.exe'},
    // Eden/Yuzu/Lichii settings dialogs share the emulator executable with the game.
    { titlePattern: /^(?:Eden|yuzu|Lichii)\s+Configuration(?:\s+-.*)?$/i },
    { titlePattern: 'GSM Overlay' },
    { titlePattern: 'GitHub Desktop' },
    { titlePattern: 'OBS Studio' },
    { titlePattern: 'iCUE' },
    { titlePattern: 'Magpie' },
    { titlePattern: 'Calculator' },
    { titlePattern: '[Select a window to capture]' },
    { titlePattern: 'Microsoft Edge Game Assist' },
    { titlePattern: /^.*Prism Launcher .*$/ },
    { titlePattern: /^.*mRemoteNG.*$/ },
    { titlePattern: "Task Manager" },
    { windowClass: 'obs' },
    { windowClass: 'plasmashell' },
    { titlePattern: /^Desktop @ QRect/i },
    { titlePattern: "(null)" },

];

// -------------------------------------------------------------------------
// GAME TITLE PARSING CONFIGURATION
// -------------------------------------------------------------------------

interface TitleMatcher {
    name: string; // Identifier for debugging
    pattern: RegExp; // Regex to test if the window belongs to this category
    // Logic to extract the clean name from the MatchArray
    getName: (match: RegExpMatchArray) => string;
    // Logic to create the OBS Auto Switcher Regex based on the extracted name
    getSwitcherPattern: (cleanName: string) => string;
    priority?: number; // Lower numbers = higher priority. Default: 50. Use 100+ for fallback matchers.
}

/**
 * Expandable list of regex patterns for Emulators and Games.
 * The system checks these in order. The first match wins.
 */
const TITLE_MATCHERS: TitleMatcher[] = [
    {
        name: 'Vita3K',
        // Pattern: Vita3K [ver] | Game Name (ID) | ...
        pattern: /^Vita3K.*?\|\s*(.+?)\s*\(/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `Vita3K.*?\\|.*${escapeRegexCharacters(n.trim())}.*\\(.*`
    },
    {
        name: 'Eden/Yuzu/Suyu/Lichii (extra segments)',
        // Patterns:
        //   Eden | v0.0.4-rc1 | MSVC ... | Game Name (64-bit) | ...
        //   yuzu Early Access 4175 | Game Name (64-bit) | 1.0.0 | NVIDIA
        //   Lichii | v0.0.4 | MSVC ... | Game Name (64-bit) | ...
        // Allows emulator build text before the first pipe and additional pipe-separated
        // metadata before the segment marked with (64-bit) or (32-bit).
        pattern: /^(?:Eden|yuzu|suyu|Lichii)\b[^|]*\|\s*(?:[^|]*\|\s*)*([^|]+?)\s*\((?:64|32)-bit\)(?:\s*\||$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `(?:Eden|yuzu|suyu|Lichii)[^|]*\\|.*${escapeRegexCharacters(n.trim())}.*\\((?:64|32)-bit\\).*`,
        priority: 45,
    },
    {
        name: 'Eden/Yuzu/Suyu/Lichii',
        // Pattern: Eden | v0.0.3 | Game Name (64-bit) | ...
        // Pattern: yuzu | v0.0.3 | Game Name (64-bit) | ...
        // Pattern: suyu | v0.0.3 | Game Name (64-bit) | ...
        // Pattern: Lichii | v0.0.4 | Game Name (64-bit) | ...
        pattern: /^(?:Eden|yuzu|suyu|Lichii)\s*\|\s*v[\d.]+\s*\|\s*(.+?)\s*(\(64-bit\)|\(32-bit\)|\||$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `(?:Eden|yuzu|suyu|Lichii).*\\|.*?\\|.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'RPCS3',
        // Pattern: FPS: 30.22 | Vulkan | 0.0.38 | Demon's Souls [BLES00932]
        // Updated to use greedy matching (.*) before the pipe to skip 'Vulkan'/'Version' segments
        pattern: /^FPS:.*\|\s*([^|]+?)\s*\[\w+\]$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `FPS:.*\\|.*${escapeRegexCharacters(n.trim())}.*\\[\\w+\\]`
    },
    {
        name: 'Cemu',
        // Pattern: Cemu ... [TitleId: 000...] Breath of the Wild [US v208]
        // Anchors on the [TitleId: ...] block
        pattern: /^Cemu.*?\[TitleId:[^\]]+\]\s*(.+?)(?:\s*\[|$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `Cemu.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'Dolphin',
        // Pattern: Dolphin 5.0 | JIT | ... | Game Name (GAMEID)
        // Anchors to the Game ID in parens at the very end
        pattern: /^Dolphin.*?\|\s*([^|]+?)\s*\([A-Z0-9]{6}\)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `Dolphin.*?\\|.*${escapeRegexCharacters(n.trim())}.*\\([A-Z0-9]{6}\\)`
    },
    {
        name: 'PPSSPP',
        // Pattern: PPSSPP v1.19.3 - ULJS00186 : Game Name
        pattern: /^PPSSPP.*?-[A-Z0-9\s]+:\s*(.+)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `PPSSPP.*?:.*${escapeRegexCharacters(n.trim())}`
    },
    {
        name: 'Simple Pipe-Separated (Citra/DeSmuME)',
        // Pattern: Azahar ... | Game Name 
        // Pattern: DeSmuME ... | Game Name
        // Covers: Citra, Azahar, Lime3DS, Mandarine, DeSmuME
        pattern: /^(?:Azahar|Citra|Lime3DS|Mandarine|DeSmuME).*?\|\s*(.+?)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `(?:Azahar|Citra|Lime3DS|Mandarine|DeSmuME).*?\\|.*${escapeRegexCharacters(n.trim())}`
    },
    {
        name: 'Prefix Dash-Separated (mGBA/Flycast/Mesen)',
        // Pattern: mGBA - Game Name (Japan)
        // Pattern: Flycast - Game Name (USA)
        // Pattern: Mesen - Game Name [!]
        // Captures name, stopping before (Region) or [Flags]
        pattern: /^(?:mGBA|Flycast|Mesen)\s*-\s*(.+?)(?:\s*[\(\[].*|$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `(?:mGBA|Flycast|Mesen).*-.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'Suffix Dash-Separated (VBA-M/PJ64/Snes9x/RMG)',
        // Pattern: Game Name (U) [!] - Emulator Name ...
        // Covers: VisualBoyAdvance-M, Project64, Snes9x, Rosalie's Mupen GUI
        pattern: /^(.+?)(?:\s*[\(\[].*?)?\s*-\s*(?:VisualBoyAdvance|Project64|Snes9x|Rosalie's Mupen)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `${escapeRegexCharacters(n.trim())}.*-.*(?:VisualBoyAdvance|Project64|Snes9x|Rosalie's Mupen).*`
    },
    {
        name: 'Generic Version Suffix',
        // Pattern: Game Name - Ver1.0.0 OR Game Name ver1.00
        // Kept at the bottom as a catch-all
        pattern: /^(.+?)\s*(?:-|)\s*ver\d/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `${escapeRegexCharacters(n.trim())}.*`,
        priority: 90
    },
    {
        name: "Generic Suffix",
        // Pattern: Game Name followed by various separators and text (e.g., "Kanon プロローグ" -> "Kanon")
        // Covers: patterns with space followed by Japanese/descriptive text, or other common suffixes
        pattern: /^(.+?)\s+(?:プロローグ|エピローグ|体験版|デモ版|demo)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `.*${escapeRegexCharacters(n.trim())}.*`,
        priority: 100
    }
    // {
    //     name: 'MPV',
    //     // Pattern: .* - mpv
    //     pattern: /^(.+?)\s*-\s*mpv$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*mpv$`
    // },
    // {
    //     name: 'VLC',
    //     // Pattern: MyAnimeTitle - VLC.*
    //     pattern: /^(.+?)\s*-\s*VLC.*$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*VLC.*$`
    // },
    // {
    //     name: 'Memento',
    //     // Pattern: MyAnimeTitle - Memento
    //     pattern: /^(.+?)\s*-\s*Memento$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*Memento$`
    // }
];

// Helper to determine Scene Name and Switcher Pattern from a raw Window Title
export function getGameInfoFromWindow(rawTitle: string): { sceneName: string; switcherRegex: string } {
    // Sort matchers by priority (lower number = higher priority)
    const sortedMatchers = [...TITLE_MATCHERS].sort((a, b) => {
        const priorityA = a.priority ?? 50;
        const priorityB = b.priority ?? 50;
        return priorityA - priorityB;
    });

    for (const matcher of sortedMatchers) {
        const match = rawTitle.match(matcher.pattern);
        if (match) {
            try {
                const cleanName = matcher.getName(match);
                if (cleanName) {
                    return {
                        sceneName: cleanName,
                        switcherRegex: matcher.getSwitcherPattern(cleanName)
                    };
                }
            } catch (e) {
                console.warn(`[Capture] Error processing matcher ${matcher.name}:`, e);
            }
        }
    }

    // Fallback: Use a generic base title segment to better tolerate title changes
    const genericBaseTitle = rawTitle
        .split('|')[0]
        .split(' - ')[0]
        .trim() || rawTitle.trim();

    return {
        sceneName: rawTitle,
        switcherRegex: `.*${escapeRegexCharacters(genericBaseTitle)}.*`
    };
}

// -------------------------------------------------------------------------


export function escapeRegexCharacters(str: string): string {
    // Escape all regex special characters that could break the auto scene switcher
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Check if a window item should be filtered out
export function shouldFilterWindow(item: any): boolean {
    const windowValue = item.itemValue || '';
    const itemName = item.itemName || '';
    let exeName = '';
    let windowClass = '';
    let title = '';

    if (typeof windowValue === 'string' && windowValue.includes('\r\n')) {
        const [, encodedTitle = '', encodedWindowClass = ''] = windowValue
            .split(/\r?\n/)
            .map((part) => part.trim());
        title = itemName.trim() || encodedTitle;
        windowClass = encodedWindowClass;
    } else {
        // Parse window value format: "Title:ClassName:ExeName.exe"
        const parts = windowValue.split(':');
        exeName = parts[parts.length - 1]?.trim() || '';
        windowClass = parts[parts.length - 2]?.trim() || '';
        title = getObsWindowTitle(itemName);
    }

    for (const filter of WINDOW_FILTERS) {
        let matches = true; // Assume match unless proven otherwise

        // Check exe name filter (if specified)
        if (filter.exeName) {
            if (exeName.toLowerCase() !== filter.exeName.toLowerCase()) {
                matches = false;
            }
        }

        // Check window class filter (if specified)
        if (filter.windowClass && matches) {
            if (windowClass !== filter.windowClass) {
                matches = false;
            }
        }

        // Check title pattern filter (if specified)
        if (filter.titlePattern && matches) {
            if (typeof filter.titlePattern === 'string') {
                // Substring match for string patterns
                if (!title.includes(filter.titlePattern)) {
                    matches = false;
                }
            } else if (filter.titlePattern instanceof RegExp) {
                // Regex match for RegExp patterns
                if (!filter.titlePattern.test(title)) {
                    matches = false;
                }
            }
        }

        // If all specified conditions match, filter this window
        if (matches) {
            return true;
        }
    }

    return false;
}

