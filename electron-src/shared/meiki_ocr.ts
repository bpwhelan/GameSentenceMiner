export type MeikiModelSize = 'small' | 'large';

export interface MeikiModelStatus {
    model: MeikiModelSize;
    available: boolean;
    busy: boolean;
    error?: string;
}
