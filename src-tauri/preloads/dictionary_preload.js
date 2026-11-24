(() => {
  const initial = __GSM_DICTIONARY_CONFIG__;
  if (globalThis.__GSM_DICTIONARY_SELECT__) return;
  const popup = window !== window.top && location.href.split(/[?#]/, 1)[0] === initial.base + '/popup.html';
  if (!popup && !globalThis.__GSM_INVOKE__) return;
  const contexts = new Map(), ports = new Map();
  const frame = window === window.top ? 0 : crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  const popupFrames = new Map();
  const channelName = 'gsm.dictionary.popup';
  function request(port, message) {
    return new Promise((resolve, reject) => {
      const reply = new MessageChannel();
      const timer = setTimeout(() => {
        reply.port1.close();
        reject(Error('Dictionary popup did not respond'));
      }, 55000);
      reply.port1.onmessage = ({data}) => {
        clearTimeout(timer);
        reply.port1.close();
        if (data.error !== undefined) reject(Error(data.error));
        else resolve(data.value);
      };
      port.postMessage(message, [reply.port2]);
    });
  }
  function respond(port, handle) {
    port.onmessage = async event => {
      const reply = event.ports[0];
      if (!reply) return;
      try { reply.postMessage({value: await handle(event.data)}); }
      catch (error) { reply.postMessage({error: String(error)}); }
      finally { reply.close(); }
    };
  }
  let invoke;
  if (popup) {
    const link = new MessageChannel();
    respond(link.port1, ({type, args}) => globalThis.__GSM_DICTIONARY_DISPATCH__(initial.id, type, args, frame));
    window.parent.postMessage({channel: channelName, id: initial.id, frame}, initial.hostOrigin, [link.port2]);
    invoke = ({operation, args}) => request(link.port1, {operation, args});
    window.addEventListener('pagehide', () => link.port1.close(), {once: true});
  } else {
    invoke = params => window.__GSM_INVOKE__('dictionary_call', {params});
  }
  if (window === window.top && location.origin === initial.hostOrigin) {
    window.addEventListener('message', event => {
      const {channel, id, frame: childFrame} = event.data || {};
      const port = event.ports[0];
      if (channel !== channelName || !port || !Number.isSafeInteger(childFrame) || childFrame <= 0) return;
      const context = contexts.get(id);
      if (!context || event.origin !== context.config.base || !/yomitan/i.test(context.config.manifest.name)) return;
      const children = Array.from(window.frames);
      if (!children.includes(event.source)) return;
      for (const [key, entry] of popupFrames) {
        if (entry.source === event.source || !children.includes(entry.source)) {
          entry.port.close();
          popupFrames.delete(key);
        }
      }
      if (popupFrames.has(childFrame)) return;
      popupFrames.set(childFrame, {id, port, source: event.source});
      // The child can use its reader's messaging API. The desktop nonce and
      // native command selection stay in the parent.
      const allowed = new Set(['runtime.sendMessage', 'runtime.connect', 'tabs.connect',
        'port.message', 'port.disconnect', 'tabs.getCurrent', 'tabs.getZoom', 'commands.getAll']);
      respond(port, ({operation, args}) => {
        if (!allowed.has(operation) || !Array.isArray(args)) throw Error('Unsupported dictionary popup operation: ' + operation);
        return invoke({extension: id, operation, args, frame: childFrame});
      });
    });
  }
  function event() {
    const listeners = new Set(); return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), hasListener: listener => listeners.has(listener), hasListeners: () => listeners.size, listeners, emit: (...args) => { for (const listener of [...listeners]) listener(...args); } };
  }
  function create(config) {
    const call = (operation,args) => invoke({extension:config.id,operation,args,frame});
    const method = operation => (...args) => {
      const callback = typeof args.at(-1)==='function' ? args.pop() : null;
      if(operation==='scripting.executeScript'&&typeof args[0]?.func==='function')args[0]={...args[0],func:args[0].func.toString()};
      const pending=call(operation,args);
      if(!callback)return pending;
      void pending.then(value=>callback(value),error=>{api.runtime.lastError={message:String(error)};try{callback();}finally{delete api.runtime.lastError;}});
    };
    const connect = (operation,info,tabId) => {
      const id=crypto.randomUUID();const port=makePort(id,info?.name||'',null,call);
      port.ready=call(operation,[id,info||{},tabId]);return port;
    };
    const api={
      runtime:{id:config.id,getURL:file=>config.base+'/'+String(file||'').replace(/^\//,''),getManifest:()=>config.manifest,
        getPlatformInfo:callback=>{const result={os:window.gsmEnv?.platform==='win32'?'win':window.gsmEnv?.platform==='darwin'?'mac':'linux',arch:'x86-64'};if(callback)callback(result);else return Promise.resolve(result);},
        sendMessage:method('runtime.sendMessage'),getContexts:method('runtime.getContexts'),openOptionsPage:method('runtime.openOptionsPage'),
        connect:info=>connect('runtime.connect',info),onMessage:event(),onConnect:event(),onInstalled:event(),onStartup:event(),
        ContextType:{OFFSCREEN_DOCUMENT:'OFFSCREEN_DOCUMENT',BACKGROUND:'BACKGROUND',TAB:'TAB'}},
      storage:{onChanged:event()},tabs:{onZoomChange:event(),onRemoved:event(),onUpdated:event(),onActivated:event(),connect:(id,info)=>connect('tabs.connect',info,id)},
      windows:{onRemoved:event(),onFocusChanged:event()},offscreen:{Reason:{DOM_PARSER:'DOM_PARSER',BLOBS:'BLOBS',CLIPBOARD:'CLIPBOARD',AUDIO_PLAYBACK:'AUDIO_PLAYBACK',WORKERS:'WORKERS'}},
      permissions:{onAdded:event(),onRemoved:event()},scripting:{},userScripts:{},
      action:{},contextMenus:{onClicked:event()},commands:{onCommand:event()},omnibox:{onInputEntered:event()},
      alarms:{onAlarm:event()},downloads:{onChanged:event()},management:{},declarativeNetRequest:{},
      extension:{isAllowedFileSchemeAccess:callback=>callback?callback(true):Promise.resolve(true),isAllowedIncognitoAccess:callback=>callback?callback(false):Promise.resolve(false)},
      i18n:{getMessage:key=>key,getUILanguage:()=>navigator.language},
    };
    for(const area of ['local','sync','session']) {api.storage[area]={onChanged:event()};for(const action of ['get','set','remove','clear','getBytesInUse','setAccessLevel'])api.storage[area][action]=method(`storage.${area}.${action}`);}
    const methods={runtime:['sendMessage','getContexts','openOptionsPage'],tabs:['create','query','get','getCurrent','getZoom','update','remove','sendMessage','captureVisibleTab'],windows:['create','get','getCurrent','update','remove'],offscreen:['createDocument','closeDocument'],permissions:['contains','getAll','request','remove'],scripting:['executeScript','insertCSS','getRegisteredContentScripts','registerContentScripts','unregisterContentScripts','updateContentScripts'],userScripts:['getScripts','register','unregister'],action:['setBadgeText','setBadgeBackgroundColor','setTitle','setIcon'],contextMenus:['create','remove','removeAll'],commands:['getAll','openShortcutSettings'],alarms:['create','getAll','clear'],downloads:['download','search'],management:['getSelf'],declarativeNetRequest:['getDynamicRules','getSessionRules','updateDynamicRules','updateSessionRules']};
    for(const [namespace,names]of Object.entries(methods))for(const name of names)api[namespace][name]=method(`${namespace}.${name}`);
    // Yomitan already supports a persistent background page on WebKit/Firefox.
    // Its Chrome offscreen path transfers MessagePorts through a service worker;
    // select the existing direct IndexedDB/translator implementation instead.
    if (/yomitan/i.test(config.manifest.name)) {
      delete api.offscreen;
      // Use upstream's SharedWorker MessagePort handshake between the
      // persistent background and lookup pages on every desktop webview.
      delete Object.getPrototypeOf(navigator).serviceWorker;
    }
    contexts.set(config.id,{api,config,call});return api;
  }
  function makePort(id,name,sender,call) {
    const port={name,sender,onMessage:event(),onDisconnect:event(),ready:Promise.resolve(),
      postMessage:message=>{void port.ready.then(()=>call('port.message',[id,message])).catch(error=>{port.error=String(error);port.onDisconnect.emit(port);});},
      disconnect:()=>{void port.ready.then(()=>call('port.disconnect',[id]));ports.delete(id);port.onDisconnect.emit(port);}};
    ports.set(id,port);return port;
  }
  globalThis.__GSM_DICTIONARY_CONTEXT__=id=>{let context=contexts.get(id);if(!context){const config=initial.extensions.find(ext=>ext.id===id);if(!config)throw Error('Unknown dictionary');create({...initial,...config});context=contexts.get(id);}return context;};
  globalThis.__GSM_DICTIONARY_SELECT__=id=>{const context=globalThis.__GSM_DICTIONARY_CONTEXT__(id);globalThis.chrome=context.api;globalThis.browser=context.api;return context;};
  const own=initial.extensions.find(ext=>location.href.startsWith(ext.base+'/'));
  globalThis.__GSM_DICTIONARY_SELECT__(own?.id||initial.id);
  globalThis.__GSM_DICTIONARY_FRAME__=frame;
  globalThis.__GSM_DICTIONARY_DISPATCH__=async(id,type,args,targetFrame)=>{
    const popupTarget = popupFrames.get(targetFrame);
    if (popupTarget?.id === id) return request(popupTarget.port, {type, args});
    if (targetFrame === null && type === 'message' && popupFrames.size) {
      const replies = [];
      const children = Array.from(window.frames);
      for (const [key, child] of popupFrames) {
        if (!children.includes(child.source)) {
          child.port.close();
          popupFrames.delete(key);
        } else if (child.id === id) {
          replies.push(request(child.port, {type, args}));
        }
      }
      if (replies.length) {
        replies.push(globalThis.__GSM_DICTIONARY_DISPATCH__(id, type, args, frame));
        return Promise.any(replies.map(async reply => {
          const result = await reply;
          if (result?.handled) return result;
          throw Error('No listener responded');
        })).catch(() => ({handled: false}));
      }
    }
    if(targetFrame!==null&&targetFrame!==frame){for(const child of window.frames){try{const result=await child.__GSM_DICTIONARY_DISPATCH__?.(id,type,args,targetFrame);if(result?.handled)return result;}catch{}}return {handled:false};}
    const context=contexts.get(id);if(!context)return {handled:false};const {api,call}=context;
    if(type==='storage'){api.storage.onChanged.emit(...args);api.storage[args[1]]?.onChanged.emit(args[0]);return;}
    if(type==='alarm'){api.alarms.onAlarm.emit(...args);return;}
    if(type==='download'){api.downloads.onChanged.emit(...args);return;}
    if(type==='connect'){const port=makePort(args[0],args[1],args[2],call);api.runtime.onConnect.emit(port);return;}
    if(type==='port-message'){ports.get(args[0])?.onMessage.emit(args[1]);return;}
    if(type==='port-disconnect'){const port=ports.get(args[0]);port?.onDisconnect.emit(port);ports.delete(args[0]);return;}
    if(type!=='message')return;
    let finish;const response=new Promise(resolve=>{finish=resolve;});let asynchronous=false,answered=false;
    const respond=value=>{if(!answered){answered=true;finish({handled:true,value:value??null});}};
    for(const listener of [...api.runtime.onMessage.listeners]){
      try {const result=listener(args[0],args[1],respond);if(result===true)asynchronous=true;else if(result&&typeof result.then==='function'){asynchronous=true;result.then(value=>{if(value!==undefined)respond(value);else if(!answered)finish({handled:false});},error=>respond({error:String(error)}));}}
      catch(error){console.error('Dictionary message failed',error);}
    }
    if(!asynchronous&&!answered)return {handled:false};
    let timer;
    try {
      return await Promise.race([response,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Dictionary response timed out')),55000);})]);
    } finally { clearTimeout(timer); }
  };
  const originalFetch=globalThis.fetch.bind(globalThis);
  globalThis.fetch=async(input,options)=>{
    const request=new Request(input,options);
    const target=new URL(request.url);
    // Tauri's Windows IPC itself uses fetch to ipc.localhost. Routing that
    // request through dictionary_call would recursively invoke this wrapper.
    if(!/^https?:/.test(request.url)||target.origin===location.origin||target.hostname==='ipc.localhost'||/^gsm(?:-yomitan|-hachidori|-jiten)?\.localhost$/.test(target.hostname))return originalFetch(input,options);
    const body=['GET','HEAD'].includes(request.method)?null:new Uint8Array(await request.arrayBuffer());
    let encoded='';if(body){for(let i=0;i<body.length;i+=32768)encoded+=String.fromCharCode(...body.subarray(i,i+32768));encoded=btoa(encoded);}
    const context=contexts.get(initial.id)||contexts.values().next().value;
    const response=await context.call('fetch',[{url:request.url,method:request.method,headers:[...request.headers],body:encoded||null}]);
    const bytes=Uint8Array.from(atob(response.body),char=>char.charCodeAt(0));
    return new Response([101,204,205,304].includes(response.status)?null:bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  globalThis.__GSM_DICTIONARY_BOOTED__=new Promise(resolve=>{if(document.readyState==='complete')resolve();else window.addEventListener('load',resolve,{once:true});});
})();
