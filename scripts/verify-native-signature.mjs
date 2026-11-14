import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';

// Minisign's ED format signs a BLAKE2b-512 digest, then separately signs the
// raw signature plus its trusted comment. Match Tauri's version-bound checks.
export function verifyNativeDigest(digest, encodedSignature, encodedPublicKey, version) {
  const lines=Buffer.from(encodedSignature,'base64').toString('utf8').trim().split(/\r?\n/);
  const publicLines=Buffer.from(encodedPublicKey,'base64').toString('utf8').trim().split(/\r?\n/);
  if(lines.length!==4||!lines[2].startsWith('trusted comment: ')||publicLines.length!==2)throw Error('Invalid native update signature encoding');
  const key=Buffer.from(publicLines[1],'base64'),signature=Buffer.from(lines[1],'base64'),global=Buffer.from(lines[3],'base64');
  if(key.length!==42||signature.length!==74||global.length!==64||signature.subarray(0,2).toString()!=='ED'||!['ED','Ed'].includes(key.subarray(0,2).toString()))throw Error('Unsupported native update signature');
  if(!key.subarray(2,10).equals(signature.subarray(2,10)))throw Error('The update was signed with a different key');
  const publicKey=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key.subarray(10)]),format:'der',type:'spki'});
  const comment=lines[2].slice('trusted comment: '.length),raw=signature.subarray(10);
  if(!crypto.verify(null,digest,publicKey,raw)||!crypto.verify(null,Buffer.concat([raw,Buffer.from(comment)]),publicKey,global))throw Error('Native update signature verification failed');
  const signedVersion=comment.split('\t').find(field=>field.startsWith('version:'))?.slice(8);
  if(signedVersion!==version)throw Error('Native update signed version does not match the release');
}

export async function verifyNativeFile(filename, signature, publicKey, version) {
  const hash=crypto.createHash('blake2b512');
  for await(const chunk of createReadStream(filename))hash.update(chunk);
  verifyNativeDigest(hash.digest(),signature,publicKey,version);
}
