// Runs inside the destination dictionary origin before its background starts.
// Every batch and its checkpoint commit in the same IndexedDB transaction.
export async function importLegacyDictionary(base) {
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
  async function decode(value) {
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
  const existing = await indexedDB.databases();
  const checkpointStore = '__gsm_transfer_checkpoint__';
  const skipped = new Set();
  let transferred = 0;
  const advance = count => {transferred+=count;if(globalThis.__GSM_TRANSFER__?.status==='running')globalThis.__GSM_TRANSFER__.records=transferred;};
  for (const schema of manifest.databases) {
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
        const decoded = await Promise.all(entries.map(async entry => ({key:await decode(entry.key), value:await decode(entry.value)})));
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
  return {databases:manifest.databases.length-skipped.size, records:manifest.batches.filter(batch=>!skipped.has(batch.database)).reduce((sum,batch)=>sum+batch.count,0), preservedNativeDatabases:[...skipped]};
}
