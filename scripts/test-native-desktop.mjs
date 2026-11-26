import {runNativeSmokeProcess} from './run-native-smoke-process.mjs';
import fs from 'node:fs/promises';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createDictionaryFixture} from './dictionary-fixture.mjs';
import {nativeExecutable, nativeTargetDirectory} from './native-paths.mjs';

const root=path.resolve(import.meta.dirname,'..');
const executable=nativeExecutable();
const temp=await fs.mkdtemp(path.join(process.env.GSM_SMOKE_PARENT || os.tmpdir(),'gsm-native-smoke-'));
const modes=process.argv.slice(2);
const targets=modes.length?modes:['runtime','foundation','yomitan','hachidori','home','overlay'];

for(const mode of targets) {
  const profile=path.join(temp,mode);await fs.mkdir(profile,{recursive:true});
  if (mode === 'ocr-preview' || mode === 'mining-settings') {
    // Exercise the normal tab bar after first-run onboarding.
    await fs.mkdir(path.join(profile, 'electron'), {recursive: true});
    await fs.writeFile(path.join(profile, 'electron/config.json'), JSON.stringify({hasCompletedSetup: true}));
  }
  // Give the workspace check neither a checkout .venv nor a managed Python.
  const database = ['database', 'database-recovery', 'vocabulary'].includes(mode);
  const longplay = mode === 'longplay';
  const capture = mode === 'clip-capture';
  const speech = mode === 'speech';
  const modelSettings = mode === 'ocr-model-settings';
  const pythonless = mode === 'pythonless';
  const miningSettings = mode === 'mining-settings';
  const cardReview = mode === 'card-review';
  if (speech && (!process.env.GSM_WINDOWS_AUDIO_HELPER || !process.env.GSM_WINDOWS_SAPI_HELPER)) {
    throw Error('Set GSM_WINDOWS_AUDIO_HELPER and GSM_WINDOWS_SAPI_HELPER to the compiled speech fixture.');
  }
  let ankiFixture;
  let offlineObs;
  const lookups = [];
  const miningWrites = [];
  const translationPrompts = [];
  let miningPolls = 0;
  let pollingNoteAvailable = false;
  let scopedSearches = 0;
  let expectedFrequency;
  const hasGateway = database || longplay || capture || speech || modelSettings || pythonless || miningSettings || cardReview;
  const isolated = mode === 'workspace' || mode === 'anki-grouping' || hasGateway;
  const appRoot = isolated ? path.join(profile, 'app') : root;
  if (isolated) {
    await fs.cp(process.env.GSM_SMOKE_RENDERER_DIR || path.join(root, 'dist', 'renderer'), path.join(appRoot, 'dist', 'renderer'), {recursive: true});
    // A raw cargo binary has no sibling input helper. Stage the built native
    // helper alone so the isolated wizard can exercise real dictionary setup.
    const helper = process.platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
    const sibling = path.join(path.dirname(executable), helper);
    const hasSibling = (await fs.stat(sibling).catch(() => null))?.isFile();
    if (pythonless || !hasSibling) {
      const relative = 'GSM_Overlay/input_server/target/release';
      let source = sibling;
      if (!hasSibling) {
        const inputTarget = await nativeTargetDirectory({manifest: 'GSM_Overlay/input_server/Cargo.toml'});
        const configured = path.join(inputTarget, 'release', helper);
        source = (await fs.stat(configured).catch(() => null))?.isFile()
          ? configured
          : path.join(root, relative, helper);
      }
      const development = path.join(appRoot, relative, helper);
      const packaged = path.join(appRoot, 'GSM_Overlay', helper);
      await fs.mkdir(path.dirname(development), {recursive: true});
      await fs.copyFile(source, development);
      await fs.link(development, packaged).catch(() => fs.copyFile(source, packaged));
    }
  }
  let reviewedSentence = '本を読む';
  if (cardReview) {
    const audio = Buffer.alloc(44 + 32000);
    audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
    audio.write('data', 36); audio.writeUInt32LE(32000, 40);
    for (let i = 0; i < 16000; i++) audio.writeInt16LE(Math.round(4000 * Math.sin(i * Math.PI / 20)), 44 + i * 2);
    await fs.writeFile(path.join(profile, 'review-fixture.wav'), audio);
    ankiFixture = createHttpServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks));
      if (message.action === 'updateNoteFields') reviewedSentence = message.params.note.fields.Sentence;
      const replies = { getActiveProfile: 'Fixture', notesInfo: [{
        noteId: 101, modelName: 'Mining', tags: [], cards: [201],
        fields: { Vocabulary: { value: '読む', order: 0 }, Sentence: { value: reviewedSentence, order: 1 } },
      }], guiSelectedNotes: [], updateNoteFields: null };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ result: replies[message.action] ?? null, error: null }));
    });
    await new Promise((resolve, reject) => ankiFixture.once('error', reject).listen(0, '127.0.0.1', resolve));
    ankiFixture.unref();
    const entry = path.join(profile, 'session_review', 'fixture');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'replay.mkv'), '');
    await fs.writeFile(path.join(entry, 'manifest.json'), JSON.stringify({ clip: { file: 'replay.mkv' }, lines: [] }));
    await fs.writeFile(path.join(entry, 'review.json'), JSON.stringify({
      version: 1, status: 'pending', profile_name: 'Default', created_at: '2026-11-21T10:00:00Z',
      scene: 'Fixture', note_id: 101, model_name: 'Mining', anki_profile: 'Fixture',
      anki_url: 'http://127.0.0.1:' + ankiFixture.address().port,
      anki_config: { word_field: 'Vocabulary', sentence_field: 'Sentence', picture_field: 'Picture',
        sentence_audio_field: 'SentenceAudio', sentence_furigana_field: '' },
      expression: '読む', sentence: '本を読む', translation: '', fields: { Sentence: '本を読む' },
    }));
  }
  if (longplay || mode === 'vocabulary') {
    ankiFixture = createHttpServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/fixture/lookups') return response.end(JSON.stringify(lookups));
      if (request.url === '/fixture/mining-polls') {
        if (request.method === 'POST') pollingNoteAvailable = true;
        return response.end(JSON.stringify(miningPolls));
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks));
      if (request.url === '/chat/completions') {
        const prompt = message.messages[1].content;
        translationPrompts.push(prompt);
        const content = prompt.includes('次の<b>録画</b>') ? 'Next <b>recording</b>' : 'Next recording';
        return response.end(JSON.stringify({choices:[{message:{content}}]}));
      }
      let result = [];
      let error = null;
      if (mode === 'vocabulary') {
        const query = 'Vocabulary:_* note:"Mining"';
        if (message.action === 'findNotes' && message.params.query === query) scopedSearches++;
        const replies = {
          version:6,
          findNotes:message.params.query !== query || scopedSearches === 1 ? [] :
            scopedSearches === 2 ? ['bad',99,...Array.from({length:501},(_,i)=>i+100),601] : [101],
          findCards:message.params.query === query && scopedSearches > 1 ? [102] : [],
          notesInfo:[{noteId:101,modelName:'Mining',tags:['Game::fixture'],fields:{Vocabulary:{value:'読書'}}}],
          cardsInfo:[{cardId:102,note:101,interval:7}],
          getReviewsOfCards:{102:[{id:1600000000000,ease:3,ivl:7,time:2400}]},
        };
        result = replies[message.action];
        if (message.action === 'notesInfo' && scopedSearches === 2) {
          const page = message.params.notes;
          if (page.length === 500 && page[0] === 100 && page[499] === 599) {
            result = null;
            error = 'Fixture page unavailable';
          } else if (page.length === 1 && page[0] === 600) {
            result = [{tags:['Game::fixture'],fields:{Vocabulary:{value:'読書'}}},
              {tags:['Unrelated'],fields:{Vocabulary:{value:'山'}}}];
          } else throw new Error('Unexpected live coverage page: '+JSON.stringify(page));
        }
        if (result === undefined) error = 'Unexpected fixture action ' + message.action;
      } else if (message.action === 'findNotes' && message.params.query === 'added:1') {
        miningPolls++;
        result = pollingNoteAvailable ? [44] : [];
      } else if (message.action === 'notesInfo') {
        lookups.push(...message.params.notes);
        const [id] = message.params.notes;
        if (lookups.filter(noteId => noteId === id).length === 1) {
          result = {malformed: true};
        } else if (id === 44) {
          result = [{noteId:44,modelName:'Mining',tags:['fixture-mining'],cards:[2],
            fields:{Vocabulary:{value:'録画'},Sentence:{value:'次の<b>録画</b>'},Translation:{value:''}}}];
        } else {
          // The deleted note is gone when Beacon redelivers after the lookup error.
          result = [null];
        }
      } else if (message.action === 'version') result = 6;
      else if (message.action === 'updateNoteFields' && message.params.note.id === 44) {
        miningWrites.push(message.params.note.fields);
        result = null;
      }
      else if (message.action === 'addTags' && message.params.notes[0] === 44) result = null;
      else if (message.action === 'guiSelectedNotes') result = [];
      else if (message.action !== 'findNotes') error = 'Unexpected action: ' + message.action;
      response.end(JSON.stringify({result, error}));
    });
    await new Promise((resolve, reject) => ankiFixture.once('error', reject).listen(0, '127.0.0.1', resolve));
    ankiFixture.unref();
  }
  if (capture) {
    if (!process.env.GSM_SMOKE_FFMPEG_DIR || !process.env.GSM_SMOKE_OBS_PORT) throw Error('Use benchmark_clip_capture.py --desktop to start the OBS fixture.');
    await fs.symlink(process.env.GSM_SMOKE_FFMPEG_DIR,path.join(profile,'ffmpeg'),process.platform==='win32'?'junction':'dir');
  }
  if (modelSettings) {
    if (!process.env.GSM_SMOKE_MEIKI_MODEL) throw Error('Set GSM_SMOKE_MEIKI_MODEL to the pinned small Meiki detector.');
    await fs.mkdir(path.join(profile, 'ocr_models'), {recursive:true});
    await fs.copyFile(process.env.GSM_SMOKE_MEIKI_MODEL, path.join(profile, 'ocr_models', 'meiki.text.detect.v0.1.320x192.onnx'));
    const oldInstall = path.join(profile, 'ocr', 'vita-vn-ocr');
    await fs.mkdir(oldInstall, {recursive:true});
    await fs.writeFile(path.join(oldInstall, 'installation.json'), JSON.stringify({model:'large'}));
    await fs.writeFile(path.join(oldInstall, 'native-runtime.json'), JSON.stringify({backend:'c', library:'legacy.dll'}));
    await fs.cp(path.join(root, 'GameSentenceMiner', 'assets', 'vocr'), path.join(appRoot, 'GameSentenceMiner', 'assets', 'vocr'), {recursive:true});
  }
  if (hasGateway) {
    const {DatabaseSync} = await import('node:sqlite');
    if (pythonless || miningSettings) {
      offlineObs = createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => offlineObs.once('error', reject).listen(0, '127.0.0.1', resolve));
    }
    const listener = createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    if (database) {
      const db = new DatabaseSync(path.join(profile, 'gsm.db'));
      try {
        db.exec("CREATE TABLE game_lines(id TEXT PRIMARY KEY,line_text TEXT,timestamp TEXT,game_name TEXT); INSERT INTO game_lines VALUES('old','移行','123','fixture')");
        if (mode === 'vocabulary') {
          const sources = 'GameSentenceMiner/web/templates/components/word_frequency_sources';
          await fs.cp(path.join(root,sources),path.join(appRoot,sources),{recursive:true});
          const dictionary = JSON.parse(await fs.readFile(path.join(appRoot,sources,'jiten_global.json'),'utf8'));
          expectedFrequency = {count:dictionary.entry_count, rank:dictionary.entries[0][1]};
          db.exec(await fs.readFile(path.join(root,'native/gsm-db/migrations/vocabulary_001_tables.sql'),'utf8'));
          db.prepare('INSERT INTO words(id,word) VALUES(1,?)').run(dictionary.entries[0][0]);
          db.exec("INSERT INTO word_occurrences(word_id,line_id) VALUES('1','old'); INSERT INTO word_stats_cache(word_id,occurrence_count) VALUES(1,1)");
        }
      } finally { db.close(); }
    }
    if (mode === 'database-recovery') {
      await fs.rename(path.join(profile,'gsm.db'), path.join(profile,'replacement.db'));
      await fs.writeFile(path.join(profile,'gsm.db'), 'damaged profile');
    }
    await fs.mkdir(path.join(profile,'electron'), {recursive:true});
    await fs.writeFile(path.join(profile,'electron/config.json'), JSON.stringify({databaseBackupEnabled:true, ...(pythonless ? {autoUpdateGSMApp:false} : {})}));
    await fs.writeFile(path.join(profile,'config.json'), JSON.stringify({
      current_profile:'Default', discord:{enabled:false},
      ...(mode==='vocabulary' ? {experimental:{enable_experimental_features:true,enable_tokenization:true}} : {}),
      configs:{Default:{general:{single_port:port,use_websocket:false,use_clipboard:false,target_language:'zh', ...(pythonless || miningSettings ? {open_multimine_on_startup:false} : {})},
        anki:ankiFixture ? {enabled:longplay,url:'http://127.0.0.1:'+ankiFixture.address().port,
          note_type:'Mining',word_field:'Vocabulary',tags_to_check:['fixture-mining'],
          ...(longplay ? {show_update_confirmation_dialog_v2:false, sentence_field:'Sentence',
            sentence_field_overwrite:true, picture_field:'', previous_image_field:'', sentence_audio_field:'',
            polling_rate_v2:250} : {})} : {enabled:false},
        ...(longplay ? {ai:{provider:'OpenAI', open_ai_url:'http://127.0.0.1:'+ankiFixture.address().port,
          open_ai_api_key:'fixture', open_ai_model:'fixture', add_to_anki:true, anki_field:'Translation',
          use_canned_translation_prompt:true}} : {}),
        ...(longplay || capture ? {paths:{output_folder:path.join(profile,'output'),remove_video:false,copy_trimmed_replay_to_output_folder:capture}} : {}),
        ...(capture ? {screenshot:{extension:'jpg',width:160,height:0,trim_black_bars_wip:false}} : {}),
        features:{generate_longplay:longplay},obs:capture ? {host:'127.0.0.1',port:Number(process.env.GSM_SMOKE_OBS_PORT),open_obs:false,close_obs:false} :
          {disable_recording:true, ...(offlineObs ? {host:'127.0.0.1',port:Number(process.env.GSM_SMOKE_AREA_OBS_PORT || offlineObs.address().port),open_obs:false,close_obs:false} : {})},
        advanced:{direct_websocket_port:0}}},
    }));
  }
  if (mode === 'yomitan' || mode === 'hachidori') {
    await createDictionaryFixture(root, path.join(profile, 'dictionary.zip'));
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(path.join(profile, 'gsm.db'));
    try {
      db.exec('CREATE TABLE game_lines(id TEXT PRIMARY KEY, line_text TEXT, timestamp REAL, game_name TEXT, game_id TEXT, translation TEXT)');
      db.prepare('INSERT INTO game_lines(id, line_text, timestamp, game_name) VALUES (?, ?, ?, ?)').run('home-word', '食べる', 1, 'Dictionary fixture');
    } finally {
      db.close();
    }
  }
  const phases=pythonless ? ['install','reopen'] : mode==='yomitan'||mode==='hachidori'?['import','reopen']:['run'];
  let toolStamps;
  for(const phase of phases) {
    if (pythonless && phase === 'reopen') {
      await fs.mkdir(path.join(profile, 'python_venv'));
      await fs.writeFile(path.join(profile, 'python_venv', 'pyvenv.cfg'), 'version = 3.13.2\n');
    }
    const resultFile=path.join(profile,`result-${phase}.json`);
    const env={
      ...process.env,
      ...(process.platform === 'win32' ? {PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')} : {}),
      ...(isolated ? {
        GSM_SHARED_DATA_DIR: profile,
        PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : appRoot,
      } : {}),
      ...(hasGateway ? {GSM_NATIVE_MINING:'1', GSM_DB_READ_ONLY:'0', GSM_DISABLE_DB_BACKUP:'0'} : {}),
      ...(speech ? {GSM_SPEECH_FIXTURE:'live'} : {}),
      ...(modelSettings ? {GSM_VOCR_BACKEND:'c'} : {}),
      ...(pythonless || miningSettings ? {USERPROFILE:profile,HOME:profile} : {GSM_PYTHONLESS:'0'}),
      GSM_APP_ROOT:appRoot,
      GSM_PROFILE_DIR:profile,
      GSM_SMOKE_TEST:'1',
      GSM_SMOKE_SUITE:mode,
      GSM_SMOKE_DICTIONARY:mode==='yomitan'||mode==='hachidori'?mode:'',
      GSM_SMOKE_PHASE:phase,
      GSM_TEST_RESULT:resultFile,
    };
    delete env.GSM_NODE_EXECUTABLE;delete env.GSM_TEST_SERVICE;delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_PATH;
    if (pythonless || miningSettings) delete env.GSM_PYTHONLESS;
    if (isolated) {
      delete env.VITE_DEV_SERVER_URL;
      delete env.GSM_INPUT_SERVER_URL;
      delete env.GSM_MIGRATION_PYTHON;
    }
    const result = await runNativeSmokeProcess(executable, appRoot, env, mode, phase);
    if (cardReview && reviewedSentence !== '小説を読む') {
      throw Error(`Session review did not update the fixture note: ${reviewedSentence}`);
    }
    if (pythonless) {
      const {strict:assert} = await import('node:assert');
      const {DatabaseSync} = await import('node:sqlite');
      const venv = path.join(profile, 'python_venv');
      await assert.rejects(fs.stat(path.join(profile, 'uv')), {code: 'ENOENT'});
      if (phase === 'install') {
        await assert.rejects(fs.stat(venv), {code: 'ENOENT'});
      } else {
        const marker = JSON.parse(await fs.readFile(path.join(venv, '.gsm-venv-retired.json'), 'utf8'));
        assert.equal(marker.schemaVersion, 1);
        assert.equal(marker.pythonVersion, '3.13.2');
        assert.match(marker.desktopVersion, /^\d+\.\d+\.\d+/);
        assert.ok(Number.isFinite(Date.parse(marker.markedAt)));
        assert.equal(await fs.readFile(path.join(venv, 'pyvenv.cfg'), 'utf8'), 'version = 3.13.2\n');
      }
      const db = new DatabaseSync(path.join(profile,'gsm.db'), {readOnly:true});
      try {
        const count = phase === 'install' ? 1 : 2;
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stats_reading_breaks').get().n, count);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_lines').get().n, 2 * count);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_lines WHERE line_text=? AND language=?').get('第三行','ja').n, count);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_lines WHERE line_text=? AND language=?').get('第五行','ja').n, count);
      } finally { db.close(); }
      if (process.platform === 'win32') {
        const files = ['ffmpeg/ffmpeg.exe','ffmpeg/ffprobe.exe','.config/oneocr/oneocr.onemodel'];
        const stamps = await Promise.all(files.map(async file => (await fs.stat(path.join(profile,file), {bigint:true})).mtimeNs));
        if (toolStamps) assert.deepEqual(stamps, toolStamps);
        toolStamps = stamps;
      }
      console.log(`Desktop backend startup ${phase}: ${result.detail.boot_ms.toFixed(1)} ms`);
    }
    if (database) {
      const {DatabaseSync} = await import('node:sqlite');
      const {gunzipSync} = await import('node:zlib');
      const {strict:assert} = await import('node:assert');
      const saved = path.join(profile,'backup');
      const [manual] = (await fs.readdir(saved)).filter(name => /^gsm_backup_.*\.db$/.test(name));
      const [daily] = (await fs.readdir(path.join(saved,'database'))).filter(name => name.endsWith('.db.gz'));
      const restored = path.join(profile,'before-upgrade.db');
      await fs.writeFile(restored,gunzipSync(await fs.readFile(path.join(saved,'database',daily))));
      for (const file of [restored, path.join(saved,manual)]) {
        const db = new DatabaseSync(file,{readOnly:true});
        try {
          assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
          assert.equal(db.prepare("SELECT line_text FROM game_lines WHERE id='old'").get().line_text,'移行');
          if (file === restored) assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);
          else {
            assert.equal(db.prepare("SELECT language FROM game_lines WHERE id='old'").get().language,'zh');
            assert.equal(db.prepare('SELECT count(*) AS n FROM cron_table').get().n,mode==='vocabulary'?10:8);
            if (mode === 'database') {
              assert.equal(db.prepare('SELECT CAST(total_characters AS INTEGER) AS n FROM daily_stats_rollup').get().n,2);
              assert.equal(db.prepare("SELECT games.title_original AS title FROM game_lines JOIN games ON game_lines.game_id=games.id WHERE game_lines.id='old'").get().title,'fixture');
              assert.equal(db.prepare("SELECT count(*) AS n FROM cron_table WHERE name IN ('daily_stats_rollup','populate_games') AND last_run IS NOT NULL").get().n,2);
            }
            if (mode==='vocabulary') {
              assert.equal(db.prepare("SELECT count(*) AS n FROM anki_notes JOIN anki_cards USING(note_id) JOIN anki_reviews USING(card_id) WHERE anki_notes.note_id=101 AND anki_cards.card_id=102 AND anki_reviews.ease=3").get().n,1);
              assert.equal(db.prepare('SELECT count(*) AS n FROM word_global_frequencies').get().n,expectedFrequency.count);
              assert.equal(db.prepare('SELECT first_seen_line_id FROM words WHERE id=1').get().first_seen_line_id,'old');
              assert.equal(db.prepare('SELECT active_global_rank FROM word_stats_cache WHERE word_id=1').get().active_global_rank,expectedFrequency.rank);
            }
          }
        } finally { db.close(); }
      }
    }
    console.log(`PASS native ${mode}/${phase}`);
  }
  if (offlineObs) await new Promise(resolve => offlineObs.close(resolve));
  if (ankiFixture) {
    await new Promise(resolve => ankiFixture.close(resolve));
    const {strict:assert} = await import('node:assert');
    if (longplay) {
      assert.deepEqual(lookups, [44, 44, 42, 42]);
      assert.equal(miningWrites.length, 1);
      assert.equal(miningWrites[0].Translation, 'Next <b>recording</b>');
      assert.equal(translationPrompts.length, 2);
      assert.ok(translationPrompts[0].includes('次の録画'));
      assert.ok(translationPrompts[1].includes('次の<b>録画</b>'));
    }
    if (mode === 'vocabulary') assert.equal(scopedSearches, 3);
  }
}
