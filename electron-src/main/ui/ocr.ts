import { exec, spawn } from 'child_process';
import { ipcMain } from 'electron';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp,
    getOCRConfig,
    getPythonPath, getStartConsoleMinimized,
    setOCR1,
    setOCR2, setTwoPassOCR,
    setWindowName
} from "../store.js";
import { mainWindow } from "../main.js";

let ocrProcess: any = null;

export function registerOCRUtilsIPC() {
    ipcMain.on('ocr.install-owocr-deps', () => {
        const command = `${getPythonPath()} -m pip install owocr`;
        spawn('cmd', ['/c', 'start', 'cmd', '/k', command], { detached: false }); // Open in new cmd window
        mainWindow?.webContents.send('terminal-output', `Installing OWOCR dependencies in new terminal...`);
    });

    ipcMain.on('ocr.install-selected-dep', (_, dependency: string) => {
        const command = `${getPythonPath()} -m pip install ${dependency}`;
        spawn('cmd', ['/c', 'start', 'cmd', '/k', command], { detached: false }); // Open in new cmd window
        mainWindow?.webContents.send('terminal-output', `Installing ${dependency} dependencies in new terminal...`);
    });

    ipcMain.on('ocr.run-screen-selector', (_, window_title: string) => {
        setTimeout(() => {
            const ocr_config = getOCRConfig();
            spawn(getPythonPath(), ['-m', 'GameSentenceMiner.ocr.owocr_area_selector', window_title], { detached: false, stdio: 'ignore' });
            mainWindow?.webContents.send('terminal-output', `Running screen area selector in background...`);
        }, 3000);
    });

    ipcMain.on('ocr.start-ocr', () => {
        if (!ocrProcess) {
            const ocr_config = getOCRConfig();
            const command = `${getPythonPath()} -m GameSentenceMiner.ocr.owocr_helper ${ocr_config.ocr1} ${ocr_config.ocr2} ${ocr_config.twoPassOCR ? "1" : "0"}`;
            ocrProcess = spawn('cmd', ['/c', 'start', 'cmd', '/k', command], { detached: false }); // Open in new cmd window
            console.log(`Starting OCR process with command: ${command}`);

            ocrProcess.on('ocr.exit', (code:any, signal:any) => {
                ocrProcess = null;
                console.debug(`OCR process exited with code: ${code}, signal: ${signal}`);
            });

            ocrProcess.on('ocr.error', (err:any) => {
                console.debug(`OCR process error: ${err}`);
                ocrProcess = null;
            });
        }
    });

    ipcMain.on('ocr.kill-ocr', () => {
        if (ocrProcess) {
            exec(`taskkill /F /PID ${ocrProcess.pid}`, (error, stdout, stderr) => {
                if(error){
                    mainWindow?.webContents.send('terminal-error', `Error killing OCR process: ${stderr}`);
                }
                mainWindow?.webContents.send('terminal-output', `Killing OCR Process...`);
            });
            ocrProcess = null;
        }
    });

    ipcMain.on('ocr.restart-ocr', () => {
        if (ocrProcess) {
            exec(`taskkill /F /PID ${ocrProcess.pid}`, (error, stdout, stderr) => {
                if(error){
                    mainWindow?.webContents.send('terminal-error', `Error killing OCR process: ${stderr}`);
                }
                mainWindow?.webContents.send('terminal-output', `Restarting OCR Process...`);
            });
            ocrProcess = null;
        }
        ipcMain.emit('start-ocr');
    });

    ipcMain.on('ocr.save-two-pass', (_, twoPass: boolean) => {
        setTwoPassOCR(twoPass); // Save to persistent storage
        console.debug(`two-pass OCR saved: ${twoPass}`);
    });

    ipcMain.on('ocr.save-window-name', (_, windowName: string) => {
        setWindowName(windowName); // Save to persistent storage
        mainWindow?.webContents.send('terminal-output', `Window name saved: ${windowName}`);
    });

    // Save OCR option 1
    ipcMain.on('ocr.save-ocr1', (_, ocr1: string) => {
        setOCR1(ocr1); // Save to persistent storage
        mainWindow?.webContents.send('terminal-output', `OCR Option 1 saved: ${ocr1}`);
    });

    // Save OCR option 2
    ipcMain.on('ocr.save-ocr2', (_, ocr2: string) => {
        setOCR2(ocr2); // Save to persistent storage
        mainWindow?.webContents.send('terminal-output', `OCR Option 2 saved: ${ocr2}`);
    });

    ipcMain.handle("ocr.get-ocr-config", () => {
        const ocr_config = getOCRConfig();
        return ocr_config;
        // return {
        //     ocr1: ocr_config.ocr1,
        //     ocr2: ocr_config.ocr2,
        //     twoPassOCR: ocr_config.twoPassOCR,
        //     window_name: ocr_config.window_name,
        // }
    });
}