import {verify,createPublicKey} from 'node:crypto';
export type ReleaseAsset={url:string;bytes:number;sha256:string};
export type DesktopRelease={format:1;version:string;coreVersion:string;channel:'stable';sourceRevision:string;platform:'darwin';arch:'arm64'|'x64';minimumOs:string;protocol:{min:number;max:number};schema:{min:number;max:number};issuedAt:number;expiresAt:number;teamId:string;notesUrl:string;installer:ReleaseAsset;updater:ReleaseAsset};
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;
export function versionParts(value:string):number[]{if(!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value))throw Error('Invalid stable version');return value.split('.').map(Number);}
export function newerVersion(candidate:string,current:string):boolean{const a=versionParts(candidate),b=versionParts(current);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]!>b[i]!;}return false;}
export function verifiedRelease(raw:Uint8Array,input:{publicKey:string;teamId:string;now:number}):DesktopRelease {
 if(raw.byteLength>1024*1024)throw Error('Release metadata too large');
 const envelope=JSON.parse(Buffer.from(raw).toString('utf8'));
 if(!envelope||Object.keys(envelope).sort().join(',')!=='payload,signature'||typeof envelope.payload!=='string'||typeof envelope.signature!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature))throw Error('Invalid release envelope');
 const payload=Buffer.from(envelope.payload,'base64'),signature=Buffer.from(envelope.signature,'base64'),key=createPublicKey(input.publicKey);
 if(key.asymmetricKeyType!=='ed25519'||signature.length!==64||!verify(null,payload,key,signature))throw Error('Release publisher verification failed');
 const r=JSON.parse(payload.toString('utf8')) as DesktopRelease;
 if(!r||r.format!==1||r.channel!=='stable'||r.platform!=='darwin'||!['arm64','x64'].includes(r.arch)||r.teamId!==input.teamId||!/^[A-Z0-9]{10}$/.test(r.teamId)||!/^[a-f0-9]{40}$/.test(r.sourceRevision))throw Error('Invalid release identity');
 versionParts(r.version);versionParts(r.coreVersion);versionParts(r.minimumOs);
 if(!integer(r.issuedAt)||!integer(r.expiresAt)||r.issuedAt>input.now+300000||r.expiresAt<=input.now||r.expiresAt-r.issuedAt>7*86400000||r.expiresAt<=r.issuedAt)throw Error('Expired or invalid release');
 for(const range of [r.protocol,r.schema])if(!range||!integer(range.min)||!integer(range.max)||range.min>range.max)throw Error('Invalid compatibility range');
 const tag='desktop-v'+r.version,base='https://github.com/sifr01-labs/EstaCoda/releases/';
 if(r.notesUrl!==base+'tag/'+tag)throw Error('Invalid release notes');
 for(const [asset,extension] of [[r.installer,'dmg'],[r.updater,'zip']] as const){
  if(!asset||!integer(asset.bytes)||asset.bytes===0||asset.bytes>2*1024*1024*1024||!/^[a-f0-9]{64}$/.test(asset.sha256)||asset.url!==base+'download/'+tag+'/EstaCoda-'+r.version+'-darwin-'+r.arch+'.'+extension)throw Error('Invalid release asset');
 }
 return r;
}
export function compatibleRelease(r:DesktopRelease,current:{platform:string;arch:string;os:string;protocol:number;schema:number}):boolean{
 return r.platform===current.platform&&r.arch===current.arch&&!newerVersion(r.minimumOs,current.os)&&r.protocol.min<=current.protocol&&r.protocol.max>=current.protocol&&r.schema.min<=current.schema&&r.schema.max>=current.schema;
}
