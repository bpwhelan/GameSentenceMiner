import {spawn} from 'node:child_process';
import {nativeExecutable, root} from './native-paths.mjs';

// build-native-dev.mjs already launches from a hashed copy, so Cargo can rebuild
// while GSM runs. Its launch record is also what in-app restarts relaunch; never
// rewrite or delete it here.
const args = process.argv.slice(2);
const separator = args.indexOf('--');
const forwarded = separator === -1 ? args : args.slice(separator + 1);
const env = {...process.env, GSM_APP_ROOT: root};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(nativeExecutable(), forwarded, {cwd: root, env, stdio: 'inherit'});
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 0));
