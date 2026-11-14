import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function signingEnvironment() {
  const environment = {...process.env};
  if (!environment.TAURI_SIGNING_PRIVATE_KEY) {
    const filename = environment.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(os.homedir(), '.config/GameSentenceMiner/signing/tauri.key');
    environment.TAURI_SIGNING_PRIVATE_KEY = await fs.readFile(filename, 'utf8').catch(() => {
      throw Error('Configure the GSM update signing key before building or signing a release.');
    });
  }
  environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
  return environment;
}
