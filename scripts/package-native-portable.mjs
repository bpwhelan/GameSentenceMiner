import fs from 'node:fs/promises';
import path from 'node:path';
import {createWriteStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import archiver from 'archiver';

export async function packagePortable(source,filename) {
  for (const relative of ['GameSentenceMiner.exe', 'app/dist/renderer/index.html', 'app/pyproject.toml', 'app/native/agent-runtime.json']) {
    await fs.access(path.join(source,relative));
  }
  await fs.mkdir(path.dirname(filename),{recursive:true});
  await new Promise((resolve,reject)=>{
    const stream=createWriteStream(filename),zip=archiver('zip',{zlib:{level:6}});
    stream.on('close',resolve);stream.on('error',reject);zip.on('error',reject);zip.pipe(stream);
    zip.directory(source,false);void zip.finalize();
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2]||!process.argv[3])throw Error('Provide a portable application folder and output ZIP.');
  await packagePortable(path.resolve(process.argv[2]),path.resolve(process.argv[3]));
}
