export const GAME_PRIVILEGE_WARNING_CHANNEL = 'game-privileges.warning';

export interface GamePrivilegeWarning {
    id: string;
    pid: number;
    exeName: string;
}
