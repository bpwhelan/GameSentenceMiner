import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import path from 'node:path';

// electron-updater accepts JSON as YAML. Hash exactly the files served by the release.
export async function electronUpdateMetadata(version, artifacts) {
  const files = [];
  for (const artifact of artifacts) {
    const hash = createHash('sha512');
    let size = 0;
    for await (const chunk of createReadStream(artifact)) {
      size += chunk.length;
      hash.update(chunk);
    }
    files.push({url: path.basename(artifact), sha512: hash.digest('base64'), size});
  }
  return {version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: new Date().toISOString()};
}
