export type VitaModelSize = 'small' | 'normal' | 'large';

export interface VitaModelStatus {
    model: VitaModelSize;
    available: boolean;
    supported?: boolean;
    busy: boolean;
    installed: VitaModelSize[];
    revision: string;
    release: string;
    error?: string;
}
