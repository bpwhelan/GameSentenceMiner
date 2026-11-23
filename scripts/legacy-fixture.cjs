// Electron is used only to produce a genuine old-format test fixture. The
// production transfer uses the read-only Python decoder, never Electron.
const {app,session,BrowserWindow,protocol}=require('electron');
protocol.registerSchemesAsPrivileged([{scheme:'chrome-extension',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const fs=require('node:fs');const path=require('node:path');
const root=process.env.GSM_LEGACY_FIXTURE;
if(!root)throw Error('An isolated fixture directory is required');
app.setPath('userData',path.join(root,'legacy-shell'));
app.whenReady().then(async()=>{
  const extensionPath=path.join(root,'extension');fs.mkdirSync(extensionPath,{recursive:true});
  const kind=process.env.GSM_LEGACY_KIND||'yomitan';
  const bundled=JSON.parse(fs.readFileSync(path.join(__dirname,`../GSM_Overlay/${kind}/manifest.json`)));
  fs.writeFileSync(path.join(extensionPath,'manifest.json'),JSON.stringify({manifest_version:3,name:`${kind} transfer fixture`,version:'1.0',key:bundled.key,permissions:['storage','unlimitedStorage']}));
  fs.writeFileSync(path.join(extensionPath,'index.html'),'<!doctype html><title>Legacy transfer fixture</title>');
  const profile=path.join(root,'legacy-overlay');
  const storage=session.fromPath(profile);
  const extension=await storage.extensions.loadExtension(extensionPath);
  const window=new BrowserWindow({show:false,webPreferences:{session:storage}});
  await window.loadURL(`chrome-extension://${extension.id}/index.html`);
  await window.webContents.executeJavaScript(`(async()=>{
    const opening=indexedDB.open('gsm-migration-fixture',3);
    opening.onupgradeneeded=()=>{const db=opening.result;
      const terms=db.createObjectStore('terms',{keyPath:'id',autoIncrement:true});terms.createIndex('expression','expression',{unique:false});
      db.createObjectStore('media');db.createObjectStore('compound',{keyPath:['term','reading']});
    };
    const db=await new Promise((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error);});
    const tx=db.transaction(['terms','media','compound'],'readwrite');
    tx.objectStore('terms').put({id:1,expression:'食べる',definition:'old definition'});
    tx.objectStore('terms').put({id:1,expression:'食べる',definition:'to eat'});
    tx.objectStore('terms').put({id:99,expression:'deleted'});tx.objectStore('terms').delete(99);
    tx.objectStore('media').put({date:new Date('2026-01-02T03:04:05Z'),bytes:new Uint8Array([0,1,255]),blob:new Blob(['日本語'],{type:'text/plain'}),large:2n**80n},'sample');
    tx.objectStore('compound').put({term:'食べる',reading:'たべる',value:42});
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
    await chrome.storage.local.set({options:{language:'ja',enabled:true,profiles:[],profileCurrent:0}});
  })().catch(error=>{throw Error(String(error)+' '+error.stack);})`);
  if(kind==='hachidori')await window.webContents.executeJavaScript(`(async()=>{
    await chrome.storage.local.set({options:{language:'ja',enabled:true},dictionaryState:{schemaVersion:1,revision:0,dictionaries:[],groups:[]}});
    const root=await navigator.storage.getDirectory().catch(error=>{throw Error('OPFS root: '+String(error));});
    const folder=await root.getDirectoryHandle('.hdw-generation-fixture',{create:true});
    const dictionary=await folder.getDirectoryHandle('日本語',{create:true});
    async function write(name,text){const handle=await dictionary.getFileHandle(name,{create:true});const stream=await handle.createWritable();await stream.write(text);await stream.close();}
    await write('index.json','old');await write('index.json','日本語 dictionary');
    await write('.hoshidicts_6','fixture');await write('deleted.bin','must not return');await dictionary.removeEntry('deleted.bin');
    const opening=indexedDB.open('hachidori-debug-log',1);opening.onupgradeneeded=()=>opening.result.createObjectStore('events');
    const db=await new Promise((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error);});
    const tx=db.transaction('events','readwrite');tx.objectStore('events').put('old diagnostic','legacy');
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  })().catch(error=>{throw Error(String(error)+' '+error.stack);})`);
  storage.flushStorageData();window.destroy();
  fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({id:extension.id,profile,extensionPath,kind}));
  app.quit();
}).catch(error=>{console.error(String(error),error.stack);app.exit(1);});
