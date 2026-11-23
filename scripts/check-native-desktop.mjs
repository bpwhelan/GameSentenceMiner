import {spawn} from 'node:child_process';
const browserTransfers = process.platform === 'win32' ? ['transfer-browser-yomitan', 'transfer-browser-hachidori'] : [];
for(const scenario of ['services','windows','settings','database','database-recovery','vocabulary','longplay',...(process.platform==='win32'?['input','notifications']:[]),'yomitan','hachidori','workspace','overlay','transfer','transfer-hachidori', ...browserTransfers]) {
  const script=scenario==='services'?'scripts/test-native-services.mjs':scenario.startsWith('transfer')?'scripts/test-native-transfer.mjs':'scripts/test-native-desktop.mjs';
  const args = scenario === 'services' ? [] : [browserTransfers.includes(scenario) ? '--browser' : scenario];
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{stdio:'inherit',windowsHide:true,env:{...process.env,GSM_LEGACY_KIND:scenario.startsWith('transfer') && scenario.endsWith('hachidori')?'hachidori':'yomitan'}});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Native ${scenario} verification failed (${code})`)));
  });
}
