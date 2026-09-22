import { app, BrowserWindow, dialog, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BASE_DIR } from '../util.js';
import { createAnonymizedLogsArchive, listLogFiles } from './log_archive.js';

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

        const files = await listLogFiles(logsDir);

        if (files.length === 0) {
            dialog.showErrorBox('No Log Files', 'No log files found in the logs directory.');
            return;
        }

        const downloadsDir = app.getPath('downloads');
        const saveDialogOptions = {
            title: 'Save Anonymized GSM Logs',
            defaultPath: path.join(
                downloadsDir,
                `GSM_Logs_Anonymized_${new Date().toISOString().slice(0, 10)}.zip`
            ),
            filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        };
        const result = mainWindow
            ? await dialog.showSaveDialog(mainWindow, saveDialogOptions)
            : await dialog.showSaveDialog(saveDialogOptions);

        if (result.canceled || !result.filePath) {
            return;
        }

        await createAnonymizedLogsArchive(logsDir, result.filePath);
        const exportCompleteDialogOptions = {
            type: 'info' as const,
            title: 'Anonymized Logs Exported',
            message: `Anonymized logs successfully exported to:\n${result.filePath}`,
            detail: 'Detected usernames, home paths, computer names, email/IP addresses, and common credentials were redacted before creating the ZIP, including compressed log history. Your original logs are unchanged.\n\nAutomatic redaction may miss personal details in free text. Review the exported logs before sharing.',
            buttons: ['OK', 'Open Folder'],
        };
        const dialogResponse = mainWindow
            ? await dialog.showMessageBox(mainWindow, exportCompleteDialogOptions)
            : await dialog.showMessageBox(exportCompleteDialogOptions);
        if (dialogResponse.response === 1) {
            shell.showItemInFolder(result.filePath);
        }
    } catch (error) {
        console.error('Error zipping logs:', error);
        dialog.showErrorBox('Export Failed', `Failed to export logs: ${(error as Error).message}`);
    }
}
