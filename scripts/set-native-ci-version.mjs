import fs from 'node:fs';
const version=process.env.GSM_RELEASE_VERSION;
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version||''))throw Error('Invalid coordinated desktop version');
const packageInfo=JSON.parse(fs.readFileSync('package.json'));
packageInfo.version=version;fs.writeFileSync('package.json',JSON.stringify(packageInfo,null,2)+'\n');
const lock=JSON.parse(fs.readFileSync('package-lock.json'));
lock.version=lock.packages[''].version=version;fs.writeFileSync('package-lock.json',JSON.stringify(lock,null,2)+'\n');
