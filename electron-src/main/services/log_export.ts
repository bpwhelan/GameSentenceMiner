import { app, BrowserWindow, dialog, shell } from 'electron';
import archiver from 'archiver';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BASE_DIR } from '../util.js';

export async function exportLogsArchive(mainWindow: BrowserWindow | null): Promise<void> {
    try {
        const logsDir = path.join(BASE_DIR, 'logs');

        if (!fs.existsSync(logsDir)) {
            dialog.showErrorBox(
                'No Logs Found',
                'No logs directory found. No logs have been generated yet.'
            );
            return;
        }

        const files = fs
            .readdirSync(logsDir)
            .filter((file) => file.includes('.log') || file.includes('.txt'));

        if (files.length === 0) {
            dialog.showErrorBox('No Log Files', 'No log files found in the logs directory.');
            return;
        }

        const downloadsDir = app.getPath('downloads');
        const saveDialogOptions = {
            title: 'Save GSM Logs Archive',
            defaultPath: path.join(
                downloadsDir,
                `GSM_Logs_${new Date().toISOString().slice(0, 10)}.zip`
            ),
            filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        };
        const result = mainWindow
            ? await dialog.showSaveDialog(mainWindow, saveDialogOptions)
            : await dialog.showSaveDialog(saveDialogOptions);

        if (result.canceled || !result.filePath) {
            return;
        }

        const output = fs.createWriteStream(result.filePath);
        const archive = archiver('zip', {
            zlib: { level: 9 },
        });

        output.on('close', () => {
            console.log(`Archive created successfully: ${archive.pointer()} total bytes`);
            const exportCompleteDialogOptions = {
                type: 'info' as const,
                title: 'Logs Exported',
                message: `Logs successfully exported to:\n${result.filePath}`,
                buttons: ['OK', 'Open Folder'],
            };
            const messageBoxPromise = mainWindow
                ? dialog.showMessageBox(mainWindow, exportCompleteDialogOptions)
                : dialog.showMessageBox(exportCompleteDialogOptions);
            messageBoxPromise.then((dialogResponse) => {
                if (dialogResponse.response === 1) {
                    shell.showItemInFolder(result.filePath!);
                }
            });
        });

        archive.on('error', (err: Error) => {
            console.error('Archive error:', err);
            dialog.showErrorBox('Export Failed', `Failed to create logs archive: ${err.message}`);
        });

        archive.pipe(output);

        for (const file of files) {
            archive.file(path.join(logsDir, file), { name: file });
        }

        await archive.finalize();
    } catch (error) {
        console.error('Error zipping logs:', error);
        dialog.showErrorBox('Export Failed', `Failed to export logs: ${(error as Error).message}`);
    }
}
