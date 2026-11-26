import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import yauzl from 'yauzl';
import archiver from 'archiver';
import {DatabaseSync} from 'node:sqlite';

export function seedDictionaryGame(profile) {
  const db = new DatabaseSync(path.join(profile, 'gsm.db'));
  try {
    db.exec('CREATE TABLE game_lines(id TEXT PRIMARY KEY, line_text TEXT, timestamp REAL, game_name TEXT, game_id TEXT, translation TEXT)');
    db.prepare('INSERT INTO game_lines(id, line_text, timestamp, game_name) VALUES (?, ?, ?, ?)').run('home-word', '食べる', 1, 'Dictionary fixture');
  } finally {
    db.close();
  }
}

// Keep the media, pitch and frequency fixtures used by the overlay tests.
// Yomitan validates optional update URLs even when isUpdatable is false.
export async function createDictionaryFixture(root, destination) {
  const entries = await new Promise((resolve, reject) => {
    yauzl.open(path.join(root, 'GSM_Overlay/tests/fixtures/hachidori-fixture.zip'), {lazyEntries:true}, (error, zip) => {
      if (error) return reject(error);
      const files = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          let data = Buffer.concat(chunks);
          if (entry.fileName === 'index.json') {
            const index = JSON.parse(data); delete index.isUpdatable;
            data = Buffer.from(JSON.stringify(index));
          }
          if (entry.fileName === 'term_bank_1.json') data = Buffer.from(JSON.stringify([
            ['食べる','たべる','vt','v1',120,['to eat'],1,''],
            ['漢字','かんじ','n','',100,[{type:'structured-content',content:[{tag:'span',content:'Chinese characters'},{tag:'img',path:'media/kanji.png',width:16,height:16}]}],2,''],
          ]));
          if (entry.fileName === 'term_meta_bank_1.json') data = Buffer.from(JSON.stringify([
            ['食べる','freq',142],['食べる','pitch',{reading:'たべる',pitches:[{position:2}]}],
          ]));
          files.push({name:entry.fileName, data}); zip.readEntry();
        });
      }));
      zip.readEntry();
    });
  });
  const output = fs.createWriteStream(destination);
  const archive = archiver('zip');
  const finished = new Promise((resolve, reject) => {output.on('close', resolve);output.on('error', reject);archive.on('error', reject);});
  archive.pipe(output);
  for (const entry of entries) archive.append(entry.data, {name:entry.name});
  await archive.finalize(); await finished;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2]) {
  const root = path.resolve(import.meta.dirname, '..');
  await createDictionaryFixture(root, process.argv[2]);
}
