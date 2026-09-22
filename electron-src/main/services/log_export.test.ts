import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    listLogFiles: vi.fn(),
    createAnonymizedLogsArchive: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
    showErrorBox: vi.fn(),
    showItemInFolder: vi.fn(),
}));

vi.mock('electron', () => ({
    app: { getPath: () => '/downloads' },
    dialog: mocks,
    shell: { showItemInFolder: mocks.showItemInFolder },
}));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('../util.js', () => ({ BASE_DIR: '/gsm' }));
vi.mock('./log_archive.js', () => ({
    listLogFiles: mocks.listLogFiles,
    createAnonymizedLogsArchive: mocks.createAnonymizedLogsArchive,
}));

import { exportLogsArchive } from './log_export.js';

beforeEach(() => {
    mocks.existsSync.mockReturnValue(true);
    mocks.listLogFiles.mockResolvedValue(['main.log']);
    mocks.createAnonymizedLogsArchive.mockResolvedValue(undefined);
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/anonymized.zip' });
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
});

describe('log export dialogs', () => {
    it('identifies the export as anonymized and waits until it is safely written before showing success', async () => {
        let finish!: () => void;
        mocks.createAnonymizedLogsArchive.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
        const exporting = exportLogsArchive(null);
        await vi.waitFor(() => expect(mocks.createAnonymizedLogsArchive).toHaveBeenCalled());
        expect(mocks.showMessageBox).not.toHaveBeenCalled();
        finish();
        await exporting;

        expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Save Anonymized GSM Logs',
            defaultPath: expect.stringContaining('GSM_Logs_Anonymized_'),
        }));
        expect(mocks.createAnonymizedLogsArchive).toHaveBeenCalledWith(path.join('/gsm', 'logs'), '/downloads/anonymized.zip');
        expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Anonymized Logs Exported',
            detail: expect.stringContaining('redacted before creating the ZIP'),
        }));
        expect(mocks.showErrorBox).not.toHaveBeenCalled();
    });

    it('does not create an archive when the save dialog is cancelled', async () => {
        mocks.showSaveDialog.mockResolvedValue({ canceled: true });
        await exportLogsArchive(null);
        expect(mocks.createAnonymizedLogsArchive).not.toHaveBeenCalled();
        expect(mocks.showMessageBox).not.toHaveBeenCalled();
    });

    it('reports sanitization failures without showing success', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.createAnonymizedLogsArchive.mockRejectedValue(new Error('Unsupported encoding'));
        await exportLogsArchive(null);
        expect(mocks.showErrorBox).toHaveBeenCalledWith('Export Failed', expect.stringContaining('Unsupported encoding'));
        expect(mocks.showMessageBox).not.toHaveBeenCalled();
    });

    it('opens the completed archive location when requested', async () => {
        mocks.showMessageBox.mockResolvedValue({ response: 1 });
        await exportLogsArchive(null);
        expect(mocks.showItemInFolder).toHaveBeenCalledWith('/downloads/anonymized.zip');
    });

    it('does not offer an empty export', async () => {
        mocks.listLogFiles.mockResolvedValue([]);
        await exportLogsArchive(null);
        expect(mocks.showErrorBox).toHaveBeenCalledWith('No Log Files', expect.any(String));
        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    });
});
