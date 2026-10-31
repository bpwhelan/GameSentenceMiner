export interface SentenceExclusionsSnapshot {
    success: boolean;
    games?: Record<string, string[]>;
}

export function excludedSentences(games: Record<string, string[]>, game: string): string[] {
    return Object.prototype.hasOwnProperty.call(games, game) ? games[game] : [];
}
