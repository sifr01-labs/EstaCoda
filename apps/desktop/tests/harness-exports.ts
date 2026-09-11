// Test-only Main imports. Forge never builds or exposes this entry.
export{CredentialWindow}from'../src/main/credential-window.js';
export{CredentialPipeClient}from'../src/main/credential-pipe-client.js';
export{ServiceProcess}from'../src/main/service-process.js';
export{securePreferences,lockWindow,denySessionPermissions}from'../src/main/window-policy.js';
export{join}from'node:path';
export{pathToFileURL}from'node:url';
