import {expect, it, vi} from 'vitest';
import {InstallSessionManager} from './install_session.js';
it('reads every snapshot from the native owner without a local mirror', () => {
    const call = vi.fn(); const manager = new InstallSessionManager(call);
    call.mockReturnValueOnce({status:'running'}).mockReturnValueOnce({status:'failed'}).mockReturnValueOnce(null);
    expect(manager.getRendererSnapshot()).toEqual({status:'running'});
    expect(manager.getRendererSnapshot()).toEqual({status:'failed'});
    expect(manager.getActiveSnapshot()).toBeNull();
    expect(call.mock.calls.map(([action])=>action)).toEqual(['renderer','renderer','active']);
});
it('does not execute an expired or duplicate native retry claim', async () => {
    const call = vi.fn().mockReturnValue(false), retry = vi.fn();
    const manager = new InstallSessionManager(call); manager.ensureSession('repair', retry);
    expect(manager.executeRetry({target:'repair',ticket:'expired',lease:{sessionId:'old',attempt:1}})).toEqual({accepted:false});
    await Promise.resolve(); expect(retry).not.toHaveBeenCalled();
});
it('acknowledges a retry before its backend lifetime ends and binds delayed failure to that attempt', async () => {
    const call = vi.fn().mockReturnValue(true); let fail!:(error:Error)=>void;
    const manager = new InstallSessionManager(call);
    manager.ensureSession('repair', () => new Promise((_resolve,reject)=>{fail=reject;}));
    const lease = {sessionId:'session',attempt:2};
    expect(manager.executeRetry({target:'repair',ticket:'ticket',lease})).toEqual({accepted:true});
    await Promise.resolve(); fail(new Error('late failure'));
    await vi.waitFor(()=>expect(call).toHaveBeenCalledWith('finish',{status:'failed',message:'Installation retry failed.',error:'Error: late failure',lease}));
});
it('keeps explicit null progress when forwarding stage changes', () => {
    const call = vi.fn(); const manager = new InstallSessionManager(call);
    manager.updateStage({stageId:'python',progress:null});
    expect(call).toHaveBeenCalledWith('update',{update:{stageId:'python',progress:null},lease:undefined});
});
it('finishes only the captured native attempt after a delayed launch failure',()=>{
    const call=vi.fn();const manager=new InstallSessionManager(call);const lease={sessionId:'update',attempt:2};
    manager.finishAttempt(lease,'failed','Launch failed','Old process failure');
    expect(call).toHaveBeenCalledWith('finish',{lease,status:'failed',message:'Launch failed',error:'Old process failure'});
});
