import { ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';

// Convention: OCR messages are sent as lines starting with 'OCRMSG:' followed by JSON
// Example: OCRMSG:{"event":"started","data":{...}}

export type OCRMessage = {
    event: string;
    data?: Record<string, any>;
    id?: string | null;
};

export type OCRCommand = {
    command: string;
    data?: Record<string, any>;
    id?: string | null;
};

/**
 * Manages stdout/stdin IPC communication with the OCR Python subprocess.
 * 
 * Events emitted:
 * - 'message': (msg: OCRMessage) - Structured OCR event received
 * - 'log': { type: 'stdout' | 'stderr' | 'parse-error', message: string }
 * - 'started': OCR process started
 * - 'stopped': OCR process stopped
 * - 'paused': OCR paused
 * - 'unpaused': OCR unpaused
 * - 'status': (status: object) - Status update
 * - 'error': (error: string) - Error occurred
 * - 'ocr_result': (result: object) - OCR result
 * - 'config_reloaded': Config was reloaded
 * - 'force_stable_changed': (data: {enabled: boolean}) - Force stable mode changed
 */
export class OCRStdoutManager extends EventEmitter {
    private process: ChildProcessWithoutNullStreams;
    private buffer: string = '';

    constructor(proc: ChildProcessWithoutNullStreams) {
        super();
        this.process = proc;
        this.attachListeners();
    }

    private attachListeners() {
        this.process.stdout.on('data', (data: Buffer) => {
            this.handleStdout(data.toString());
        });
        this.process.stderr.on('data', (data: Buffer) => {
            this.emit('log', { type: 'stderr', message: data.toString() });
        });
    }

    private handleStdout(chunk: string) {
        this.buffer += chunk;
        let lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || '';
        
        for (const line of lines) {
            if (line.startsWith('OCRMSG:')) {
                try {
                    const msg: OCRMessage = JSON.parse(line.substring(7));
                    this.emit('message', msg);
                    
                    // Also emit specific events for convenience
                    if (msg.event === 'started') {
                        this.emit('started');
                    } else if (msg.event === 'stopped') {
                        this.emit('stopped');
                    } else if (msg.event === 'paused') {
                        this.emit('paused', msg.data);
                    } else if (msg.event === 'unpaused') {
                        this.emit('unpaused', msg.data);
                    } else if (msg.event === 'status') {
                        this.emit('status', msg.data);
                    } else if (msg.event === 'error') {
                        this.emit('error', msg.data?.error || 'Unknown error');
                    } else if (msg.event === 'ocr_result') {
                        this.emit('ocr_result', msg.data);
                    } else if (msg.event === 'config_reloaded') {
                        this.emit('config_reloaded');
                    } else if (msg.event === 'force_stable_changed') {
                        this.emit('force_stable_changed', msg.data);
                    }
                } catch (e) {
                    this.emit('log', { type: 'parse-error', message: line });
                }
            } else {
                this.emit('log', { type: 'stdout', message: line });
            }
        }
    }

    /**
     * Send a command to OCR process via stdin.
     */
    sendCommand(cmd: OCRCommand) {
        if (this.process.stdin.writable) {
            this.process.stdin.write('OCRCMD:' + JSON.stringify(cmd) + '\n');
        }
    }

    // Convenience command methods
    
    pause() {
        this.sendCommand({ command: 'pause' });
    }

    unpause() {
        this.sendCommand({ command: 'unpause' });
    }

    togglePause() {
        this.sendCommand({ command: 'toggle_pause' });
    }

    getStatus() {
        this.sendCommand({ command: 'get_status' });
    }

    triggerManualOCR() {
        this.sendCommand({ command: 'manual_ocr' });
    }

    reloadConfig(data?: Record<string, any>) {
        const cmd: OCRCommand = { command: 'reload_config' };
        if (data && Object.keys(data).length > 0) {
            cmd.data = data;
        }
        this.sendCommand(cmd);
    }

    stop() {
        this.sendCommand({ command: 'stop' });
    }

    toggleForceStable() {
        this.sendCommand({ command: 'toggle_force_stable' });
    }

    setForceStable(enabled: boolean) {
        this.sendCommand({ command: 'set_force_stable', data: { enabled } });
    }
}
