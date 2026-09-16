import {probeDocker,provisionDockerImage} from '../execution/docker-client.js';
import {createHash} from 'node:crypto';
import {resolveGlobalStateHome} from '../config/profile-home.js';
import {listRegisteredPythonCapabilitySpecs,getRegisteredPythonCapabilitySpec} from '../python-env/capability-registry.js';
import {checkManagedPythonCapabilityStatus,installManagedPythonCapabilityEnvironment} from '../python-env/capability-manager.js';
import {ConnectionOperations} from './connection-operations.js';
import {ControlProtocolError,type ConnectionOperation,type SettingsDependenciesPage} from '../contracts/desktop-control/index.js';
export class SettingsDependencies {
 readonly operations:ConnectionOperations;
 constructor(readonly input:{homeDir:string;profileId:string},readonly install=installManagedPythonCapabilityEnvironment,readonly docker={probe:probeDocker,provision:provisionDockerImage}){this.operations=new ConnectionOperations(input);}
 async list():Promise<SettingsDependenciesPage>{const items=[];for(const spec of listRegisteredPythonCapabilitySpecs().slice(0,31)){const state=await checkManagedPythonCapabilityStatus({stateRoot:resolveGlobalStateHome(this.input).stateRoot,capabilityId:spec.id});items.push({id:spec.id,version:spec.version,packages:spec.packages,groups:Object.keys(spec.optionalGroups??{}),estimatedMb:spec.estimatedInstallSizeMb??null,state:state.ok?'installed' as const:'install_required' as const});}const docker=await this.docker.probe();items.push({id:'docker-execution',available:docker.available,version:'bundled',packages:docker.imageId?[docker.imageId]:['bundled Docker execution image'],groups:[],estimatedMb:null,state:docker.imageId?'installed' as const:'install_required' as const});return {items};}
 async start(input:{operationId:string;capabilityId:string;groups:string[];downloadApproved:true}):Promise<ConnectionOperation>{
  if(input.capabilityId==='docker-execution'){if(input.downloadApproved!==true||input.groups.length)throw new ControlProtocolError('-32602');if(!(await this.docker.probe()).available)throw new ControlProtocolError('-32003');return new Promise((resolve,reject)=>{void this.operations.execute(input.operationId,'dependency.install:docker-execution',async()=>{await this.docker.provision();return true;},()=>{void this.operations.inspect(input.operationId).then(resolve,reject);}).then(resolve,reject);});}
  const spec=getRegisteredPythonCapabilitySpec(input.capabilityId);if(!spec||input.downloadApproved!==true||input.groups.length>8||new Set(input.groups).size!==input.groups.length||input.groups.some(group=>!Object.hasOwn(spec.optionalGroups??{},group)))throw new ControlProtocolError('-32602');
  const action='dependency.install:'+spec.id+':'+createHash('sha256').update(JSON.stringify([...input.groups].sort())).digest('hex').slice(0,16);
  return new Promise((resolve,reject)=>{void this.operations.execute(input.operationId,action,async()=>{const result=await this.install({stateRoot:resolveGlobalStateHome(this.input).stateRoot,capabilityId:spec.id,groups:input.groups});return result.ok;},()=>{void this.operations.inspect(input.operationId).then(resolve,reject);}).then(resolve,reject);});
 }
 inspect(operationId:string){return this.operations.inspect(operationId);}
}
