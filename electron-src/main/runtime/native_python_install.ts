/** Temporary application-shell adapter. Rust owns every operation and child. */
import {createRequire} from 'node:module';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {recordProcessOutput} from '../services/logging.js';
const require=createRequire(import.meta.url);
const transport=()=>require(path.join(process.env.GSM_APP_ROOT||process.cwd(),'desktop-runtime/transport.cjs'));
export function pythonSync<T=any>(action:string,params:unknown={}):T{return transport().callSync('python.call',{action,params}).result;}
export async function pythonCall<T=any>(action:string,params:Record<string,unknown>={},onProgress?:(event:{progress:number|null;message:string})=>void):Promise<T>{
    const operation=randomUUID(),rpc=transport();
    const listener=(message:any)=>{
        if(message.type!=='native-python'||message.operation!==operation)return;
        if(message.event==='progress')onProgress?.(message.data);
        else if(message.event==='log')recordProcessOutput('setup:native',message.data.stream,message.data.message);
    };
    rpc.events.on('message',listener);
    try{
        const reply=await rpc.call('python.call',{action,params:{...params,operation}});
        return reply.result;
    }
    finally{rpc.events.off('message',listener);}
}
