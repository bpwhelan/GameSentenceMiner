const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createNativeOverlay}=require('../native_overlay.cjs');
const {nativeLayout}=require('../native_layout.js');

test('duplicate sockets submit each native command once and stop follows pending commands',async()=>{
  const calls=[];
  const adapter=createNativeOverlay({enabled:true,getWindow:()=>({label:'gsm-test',isDestroyed:()=>false}),call:async(method,params)=>calls.push({method,...params})});
  const message={type:'native-overlay-command',action:'scan',text:'日本語'};
  assert.equal(adapter.receive('backend-connector',message),true);
  assert.equal(adapter.receive('ws2',message),true);
  await adapter.destroy();
  adapter.receive('ws2',message);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(c=>c.message.action),['scan','stop']);
  assert.ok(calls.every(c=>c.label==='gsm-test'));
});
test('legacy overlays do not submit native requests',async()=>{
  const adapter=createNativeOverlay({enabled:false,getWindow:()=>null,call:()=>assert.fail()});
  assert.equal(adapter.receive('ws2',{type:'native-overlay-command'}),false);
  await adapter.stop();
});
test('renderer uses native boundaries without regrouping or dropping lines',()=>{
  const layout=nativeLayout({native_layout:true,data:[{}, {}, {}],blocks:[{id:0,start:0,end:1,role:'text'},{id:1,start:2,end:2}]});
  assert.deepEqual([...layout.lineBlocks],[[0,0],[1,0],[2,1]]);
  assert.deepEqual(layout.blockBoundaries.get(0),{start:0,end:1});
  assert.equal(layout.blockCount,2);
  assert.equal(nativeLayout({native_layout:true,data:[{}],blocks:[]}),null);
  assert.equal(nativeLayout({native_layout:true,data:[{}],blocks:[{id:0,start:0,end:1}]}),null);
});
