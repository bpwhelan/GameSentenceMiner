import { app, BrowserWindow, dialog, shell } from 'electron';
import archiver from 'archiver';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BASE_DIR } from '../util.js';

export async function exportLogsArchive(mainWindow: BrowserWindow | null): Promise<void> {
    try {
        const logsDir = path.join(BASE_DIR, 'logs');
        const tempDir = path.join(BASE_DIR, 'temp');

        const { response } = await dialog.showMessageBox(mainWindow!, {
            type: 'question',
            title: 'Include Temporary Files?',
            message:
                'Do you want to include temporary files like OCR Screenshots, GSM-Created Screenshots, GSM-Created Audio, etc. in the export? This may help with debugging but will increase the size of the export.\n\nPlease be aware of the privacy implications of including these files. They should mostly just be screenshots of your game or application, but please review them if you have any concerns.',
            buttons: ['Yes', 'No'],
        });

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

        let tempFiles: string[] = [];
        if (response === 0 && fs.existsSync(tempDir)) {
            tempFiles = fs
                .readdirSync(tempDir)
                .filter((file) => fs.statSync(path.join(tempDir, file)).isFile());
        }

        if (files.length === 0) {
            dialog.showErrorBox('No Log Files', 'No log files found in the logs directory.');
            return;
        }

        const downloadsDir = app.getPath('downloads');
        const result = await dialog.showSaveDialog(mainWindow!, {
            title: 'Save GSM Logs Archive',
            defaultPath: path.join(
                downloadsDir,
                `GSM_Logs_${new Date().toISOString().slice(0, 10)}.zip`
            ),
            filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        });

        if (result.canceled || !result.filePath) {
            return;
        }

        const output = fs.createWriteStream(result.filePath);
        const archive = archiver('zip', {
            zlib: { level: 9 },
        });

        output.on('close', () => {
            console.log(`Archive created successfully: ${archive.pointer()} total bytes`);
            dialog
                .showMessageBox(mainWindow!, {
                    type: 'info',
                    title: 'Logs Exported',
                    message: `Logs successfully exported to:\n${result.filePath}`,
                    buttons: ['OK', 'Open Folder'],
                })
                .then((dialogResponse) => {
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
        for (const file of tempFiles) {
            archive.file(path.join(tempDir, file), { name: `temp/${file}` });
        }

        await archive.finalize();
    } catch (error) {
        console.error('Error zipping logs:', error);
        dialog.showErrorBox('Export Failed', `Failed to export logs: ${(error as Error).message}`);
    }
}
