
import { ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';

// Convention: GSM messages are sent as lines starting with 'GSMMSG:' followed by JSON
// Example: GSMMSG:{"function":"start","data":{...}}

export type GSMMessage = {
    function: string;
    data?: Record<string, any>;
    id?: string | null;
};

export class GSMStdoutManager extends EventEmitter {
    private process: ChildProcessWithoutNullStreams;
    private buffer: string = "";

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
        this.buffer = lines.pop() || "";
        for (const line of lines) {
            if (line.startsWith('GSMMSG:')) {
                try {
                    const msg: GSMMessage = JSON.parse(line.substring(7));
                    this.emit('message', msg);
                } catch (e) {
                    this.emit('log', { type: 'parse-error', message: line });
                }
            } else {
                this.emit('log', { type: 'stdout', message: line });
            }
        }
    }

    // Example helper: send a command to GSM via stdin (if supported)
    sendCommand(cmd: GSMMessage) {
        if (this.process.stdin.writable) {
            this.process.stdin.write('GSMCMD:' + JSON.stringify(cmd) + '\n');
        }
    }

    // Example helpers for specific commands (stubs)
    sendQuitMessage() {
        this.sendCommand({ function: 'quit' });
    }
    sendOpenSettings() {
        this.sendCommand({ function: 'open_settings' });
    }
    sendStartOBS() {
        this.sendCommand({ function: 'start_obs' });
    }
    sendQuitOBS() {
        this.sendCommand({ function: 'quit_obs' });
    }
    sendOpenTexthooker() {
        this.sendCommand({ function: 'open_texthooker' });
    }
    // ...add more as needed
}