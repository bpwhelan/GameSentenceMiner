/** Test transport to a real Rust runtime. Never loaded by the application. */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
let built = false, child: ChildProcessWithoutNullStreams | null = null, sequence = 0;
const listeners = new Set<(event: string, data: any) => void>();
const clients = new Set<string>();
const pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void }>();
export function runtimeEvents(listener: (event: string, data: any) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function runtimeSync(action: string) { if (action === 'bus.clients') return [...clients]; throw Error(`Unsupported synchronous test operation: ${action}`); }
export async function runtimeCall(action: string, params: unknown = {}): Promise<any> {
    if (action === 'bus.start') {
        if (!built) { execFileSync('cargo', ['build','--locked','--manifest-path','native/gsm-runtime/Cargo.toml','--example','service'], { windowsHide: true, stdio: 'pipe' }); built = true; }
        return new Promise((resolve, reject) => {
            const process = spawn(path.resolve('native/gsm-runtime/target/debug/examples', globalThis.process.platform === 'win32' ? 'service.exe' : 'service'), [], { windowsHide: true, stdio: 'pipe' });
            child = process; process.on('error',reject);
            process.stderr.on('data', data => globalThis.process.stderr.write(data));
            createInterface({input:process.stdout}).on('line', line => {
                const message=JSON.parse(line);
                if (message.ready) resolve(message.ready);
                else if (message.event) {
                    if (message.event === 'bus.connected') clients.add(message.data.id);
                    if (message.event === 'bus.disconnected') clients.delete(message.data.id);
                    for (const listener of listeners) listener(message.event,message.data);
                } else {
                    const request=pending.get(message.id); pending.delete(message.id);
                    message.error ? request?.reject(Error(message.error)) : request?.resolve(message.result);
                }
            });
            process.once('exit', () => { if(child===process)child=null;clients.clear();for(const request of pending.values())request.reject(Error('Native test runtime exited'));pending.clear(); });
        });
    }
    if (!child) { if (action === 'bus.stop') return; throw Error('Native test runtime not started'); }
    const process=child;
    const result=await new Promise((resolve,reject) => { const id=++sequence; pending.set(id,{resolve,reject});process.stdin.write(JSON.stringify({id,action,params})+'\n'); });
    if (action === 'bus.stop' && process.exitCode === null) await new Promise(resolve=>process.once('exit',resolve));
    return result;
}
