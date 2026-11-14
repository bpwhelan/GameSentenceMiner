import {EventEmitter} from 'node:events';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({call:vi.fn(),callSync:vi.fn(),transport:vi.fn(),recordProcessOutput:vi.fn()}));
vi.mock('node:module',()=>({createRequire:()=>mocks.transport}));
vi.mock('../services/logging.js',()=>({recordProcessOutput:mocks.recordProcessOutput}));
import {pythonCall,pythonSync} from './native_python_install.js';
let events:EventEmitter;
beforeEach(()=>{vi.resetAllMocks();events=new EventEmitter();mocks.transport.mockReturnValue({...mocks,events});});
it('correlates concurrent native operation events and removes completed listeners',async()=>{
    const finish: Array<(value:unknown)=>void>=[];
    mocks.call.mockImplementation(()=>new Promise(resolve=>finish.push(resolve)));
    const progress=vi.fn(),otherProgress=vi.fn();
    const first=pythonCall('sync',{extras:['gpu']},progress),second=pythonCall('ensure',{},otherProgress);
    const operation=mocks.call.mock.calls[0][1].params.operation;
    events.emit('message',{type:'native-python',operation,event:'progress',data:{progress:0.5,message:'Syncing'}});
    events.emit('message',{type:'native-python',operation,event:'stage',data:{stageId:'lock_sync',status:'running'}});
    events.emit('message',{type:'native-python',operation,event:'log',data:{stream:'stderr',message:'Native output'}});
    expect(progress).toHaveBeenCalledExactlyOnceWith({progress:0.5,message:'Syncing'});expect(otherProgress).not.toHaveBeenCalled();
    expect(mocks.recordProcessOutput).toHaveBeenCalledWith('setup:native','stderr','Native output');
    finish[0]({result:'done',stages:[{stageId:'lock_sync',status:'completed'}]});expect(await first).toBe('done');expect(events.listenerCount('message')).toBe(1);
    finish[1]({result:'path',stages:[]});await second;expect(events.listenerCount('message')).toBe(0);
});
it('propagates native errors and cleans up listeners',async()=>{
    mocks.call.mockRejectedValue(new Error('Restored previous Python'));
    await expect(pythonCall('reinstall')).rejects.toThrow('Restored previous Python');
    expect(events.listenerCount('message')).toBe(0);
    mocks.callSync.mockReturnValue({result:'project',stages:[]});expect(pythonSync('project')).toBe('project');
    expect(mocks.callSync).toHaveBeenCalledWith('python.call',{action:'project',params:{}});
});
