import {spawn} from 'node:child_process';
for(const scenario of ['services','windows','settings',...(process.platform==='win32'?['input','notifications']:[]),'yomitan','hachidori','workspace','overlay','transfer','transfer-hachidori']) {
  const script=scenario==='services'?'scripts/test-native-services.mjs':scenario.startsWith('transfer')?'scripts/test-native-transfer.mjs':'scripts/test-native-desktop.mjs';
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...(scenario==='services'?[]:[scenario])],{stdio:'inherit',windowsHide:true,env:{...process.env,GSM_LEGACY_KIND:scenario==='transfer-hachidori'?'hachidori':'yomitan'}});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Native ${scenario} verification failed (${code})`)));
  });
}
