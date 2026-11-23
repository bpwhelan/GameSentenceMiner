// Runs inside the destination dictionary origin before its background starts.
// Every batch and its checkpoint commit in the same IndexedDB transaction.
export async function importLegacyDictionary(base, browserFilesystem = false) {
  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  if (manifest.format !== 1) throw Error('Unsupported dictionary transfer format');
  const request = value => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
  const committed = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error || Error('Dictionary transfer was interrupted'));
  });
  function hasBinary(value) {
    if (value === null || typeof value !== 'object') return false;
    switch (value.$gsm) {
      case 'binary': return true;
      case 'array': return value.value.some(hasBinary);
      case 'object': return value.value.some(([, item]) => hasBinary(item));
      default: return false;
    }
  }
  function decodeSync(value) {
    if (value === null || typeof value !== 'object') return value;
    switch (value.$gsm) {
      case 'undefined': return undefined;
      case 'date': return new Date(value.value);
      case 'number': return Number(value.value);
      case 'bigint': return BigInt(value.value);
      case 'array': return value.value.map(decodeSync);
      case 'object': return Object.fromEntries(value.value.map(([key, item]) => [key, decodeSync(item)]));
      default: throw Error('Invalid dictionary transfer record');
    }
  }
  async function decodeAsync(value) {
    if (value === null || typeof value !== 'object') return value;
    switch (value.$gsm) {
      case 'undefined': return undefined;
      case 'date': return new Date(value.value);
      case 'number': return Number(value.value);
      case 'bigint': return BigInt(value.value);
      case 'array': return Promise.all(value.value.map(decode));
      case 'object': return Object.fromEntries(await Promise.all(value.value.map(async ([key, item]) => [key, await decode(item)])));
      case 'binary': {
        if (!/^blobs\/[a-f0-9]{64}\.bin$/.test(value.file)) throw Error('Invalid dictionary media file');
        const response = await fetch(`${base}/${value.file}`);
        if (!response.ok) throw Error('Dictionary media could not be read');
        const buffer = await response.arrayBuffer();
        if (value.kind === 'ArrayBuffer') return buffer;
        if (value.kind === 'Blob') return new Blob([buffer], {type: value.mime || ''});
        const types = {Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView};
        if (!Object.hasOwn(types, value.kind)) throw Error('Unsupported dictionary binary value');
        return new types[value.kind](buffer);
      }
      default: throw Error('Invalid dictionary transfer record');
    }
  }
  function decode(value) {
    return hasBinary(value) ? decodeAsync(value) : decodeSync(value);
  }
  const existing = await indexedDB.databases();
  const checkpointStore = '__gsm_transfer_checkpoint__';
  const skipped = new Set();
  let transferred = 0;
  const advance = count => {transferred+=count;if(globalThis.__GSM_TRANSFER__?.status==='running')globalThis.__GSM_TRANSFER__.records=transferred;};
  let filesystemRoot;
  if (browserFilesystem && manifest.databases.some(schema => schema.name === '/dicts') && await supportsDirectOpfs()) {
    filesystemRoot = await navigator.storage.getDirectory();
  }
  async function supportsDirectOpfs() {
    if (!globalThis.crossOriginIsolated || typeof Worker !== 'function' || !navigator.storage?.getDirectory) return false;
    let worker;
    try {
      const memory = new WebAssembly.Memory({initial:1, maximum:1, shared:true});
      if (!(memory.buffer instanceof SharedArrayBuffer)) return false;
      worker = new Worker('./opfs-capability-worker.js', {type:'module'});
      return await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 4000);
        const finish = ok => { clearTimeout(timer); resolve(ok); };
        worker.onmessage = ({data}) => finish(data?.channel === 'opfs-capability-result' && data.ok === true);
        worker.onerror = () => finish(false);
        worker.postMessage({channel:'opfs-capability-probe'});
      });
    } catch {
      return false;
    } finally {
      worker?.terminate();
    }
  }
  async function restoreFile(entry) {
    if (typeof entry.key !== 'string' || !entry.key.startsWith('/dicts/')) throw Error('Invalid dictionary file path');
    const parts = entry.key.slice('/dicts/'.length).split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
      throw Error('Invalid dictionary file path');
    }
    const fields = Object.fromEntries(entry.value.value);
    const filename = parts.pop();
    let folder = filesystemRoot;
    for (const part of parts) folder = await folder.getDirectoryHandle(part, {create:true});
    if ((fields.mode & 0o170000) === 0o040000) {
      await folder.getDirectoryHandle(filename, {create:true});
      return;
    }
    const file = await folder.getFileHandle(filename, {create:true});
    if (fields.contents?.$gsm === 'binary' && /^blobs\/[a-f0-9]{64}\.bin$/.test(fields.contents.file)) {
      const response = await fetch(`${base}/${fields.contents.file}`);
      if (!response.ok || !response.body) throw Error('Dictionary file could not be read');
      await response.body.pipeTo(await file.createWritable());
    } else {
      const contents = await decode(fields.contents);
      const writer = await file.createWritable();
      try {
        await writer.write(contents);
        await writer.close();
      } catch (error) {
        await writer.abort();
        throw error;
      }
    }
  }
  for (const schema of manifest.databases) {
    if (filesystemRoot && schema.name === '/dicts') {
      for (const batch of manifest.batches.filter(batch => batch.database === schema.name)) {
        const entries = await (await fetch(`${base}/${batch.file}`)).json();
        for (const entry of entries) await restoreFile(entry);
        advance(batch.count);
      }
      continue;
    }
    // Never replace a database created by the new application. A transfer can
    // resume only when this importer owns the destination checkpoint store.
    if (existing.some(item => item.name === schema.name)) {
      const current = await request(indexedDB.open(schema.name));
      const owned = current.objectStoreNames.contains(checkpointStore);
      const stores = [...current.objectStoreNames];
      const transaction = stores.length ? current.transaction(stores) : null;
      const empty = !stores.length || (await Promise.all(stores.map(name => request(transaction.objectStore(name).count())))).every(count => count === 0);
      current.close();
      // Diagnostic logs are unrelated to dictionary contents. Retain logs from
      // the native app instead of blocking the entire first-use transfer.
      if (!owned && !empty && schema.name === 'hachidori-debug-log') { skipped.add(schema.name); continue; }
      if (!owned && !empty) throw Error(`The new ${schema.name} database already contains data. Export/import the legacy dictionaries in settings to combine them; the original profile has been preserved.`);
      // Recreate only a verified empty database at its original version. Adding
      // an upgrade version would break upstream's explicit version-1 opens.
      if (!owned && empty) await request(indexedDB.deleteDatabase(schema.name));
    }
    const opening = indexedDB.open(schema.name, schema.version);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      for (const store of schema.stores) {
        const created = database.createObjectStore(store.name, {keyPath: store.keyPath, autoIncrement: store.autoIncrement});
        for (const index of store.indexes) created.createIndex(index.name, index.keyPath, {unique:index.unique, multiEntry:index.multiEntry});
      }
      database.createObjectStore(checkpointStore);
    };
    const database = await request(opening);
    try {
      for (const batch of manifest.batches.filter(batch => batch.database === schema.name)) {
        const checkpoint = `${manifest.snapshotId || 'legacy'}/${batch.file}`;
        const prior = await request(database.transaction(checkpointStore).objectStore(checkpointStore).get(checkpoint));
        if (prior) {advance(batch.count);continue;}
        const entries = await (await fetch(`${base}/${batch.file}`)).json();
        const decoded = entries.some(entry => hasBinary(entry.key) || hasBinary(entry.value))
          ? await Promise.all(entries.map(async entry => ({key:await decode(entry.key), value:await decode(entry.value)})))
          : entries.map(entry => ({key:decodeSync(entry.key), value:decodeSync(entry.value)}));
        const transaction = database.transaction([batch.store, checkpointStore], 'readwrite');
        const done = committed(transaction), store = transaction.objectStore(batch.store);
        for (const entry of decoded) store.keyPath === null ? store.put(entry.value, entry.key) : store.put(entry.value);
        transaction.objectStore(checkpointStore).put(true, checkpoint);
        await done;
        advance(batch.count);
      }
      for (const schemaStore of schema.stores.filter(store => store.autoIncrement && store.nextKey > 1)) {
        const transaction = database.transaction(schemaStore.name, 'readwrite');
        const done = committed(transaction), store = transaction.objectStore(schemaStore.name);
        const key = schemaStore.nextKey - 1;
        const value = {};
        if (typeof store.keyPath === 'string') {
          const parts = store.keyPath.split('.');let target = value;
          for (const name of parts.slice(0,-1)) target = target[name] = {};
          target[parts.at(-1)] = key;
        }
        // A deleted high key still advances Chromium's key generator.
        const check = store.getKey(key);
        check.onsuccess = () => { if (check.result === undefined) {store.keyPath === null ? store.put(value,key) : store.put(value);store.delete(key);} };
        await done;
      }
    } finally { database.close(); }
  }
  return {
    databases: manifest.databases.length - skipped.size,
    records: transferred,
    preservedNativeDatabases: [...skipped],
    ...(browserFilesystem && {filesystemBackend: filesystemRoot ? 'opfs' : 'idbfs'}),
  };
}
