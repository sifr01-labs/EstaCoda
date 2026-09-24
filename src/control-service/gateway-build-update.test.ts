import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({build:vi.fn(),readiness:vi.fn(),probe:vi.fn(),install:vi.fn(),identity:vi.fn()}));
vi.mock('../gateway/desktop-runtime-build.js',()=>({inspectDesktopRuntimeBuild:mocks.build}));
vi.mock('./supervisor-client.js',()=>({supervisorReadiness:mocks.readiness}));
vi.mock('../gateway/private-control.js',()=>({probePrivateRuntimeBuild:mocks.identity}));
vi.mock('../gateway/service-manager.js',()=>({installService:mocks.install,probeServiceState:mocks.probe,detectServiceManager:()=> 'launchd'}));
vi.mock('../cli/gateway-commands.js',()=>({runGatewayStartService:vi.fn(),runGatewayStop:vi.fn(),runGatewayRestart:vi.fn()}));
import {gatewayLifecycle} from './gateway-controls.js';
const input={homeDir:'/tmp/test-home',profileId:'selected',version:'test'},digest='a'.repeat(64);
beforeEach(()=>{vi.resetAllMocks();mocks.build.mockReturnValue({workspaceRoot:'/retained/core',digest});mocks.readiness.mockResolvedValue({state:'stopped'});mocks.probe.mockResolvedValue({installed:true});mocks.identity.mockResolvedValue(digest);mocks.install.mockImplementation(async options=>({ok:await options.verifyActivation()}));});
it('pins the backend build, requires a stopped host, and verifies authenticated startup',async()=>{
 expect(await gatewayLifecycle(input,'update')).toBe(true);
 expect(mocks.build).toHaveBeenCalledWith(undefined,undefined,true);
 expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({stateHomeDir:input.homeDir,profileId:'selected',workspaceRoot:'/retained/core',requireStopped:true,force:true}));
 expect(mocks.identity).toHaveBeenCalledWith(expect.objectContaining({profileId:'selected',version:'test'}));
});
it.each(['ready','incompatible','disconnected'])('does not replace a %s host',async state=>{mocks.readiness.mockResolvedValue({state});expect(await gatewayLifecycle(input,'update')).toEqual({ok:false,issue:'gateway_not_stopped'});expect(mocks.install).not.toHaveBeenCalled();});
it('rejects unretained or damaged builds and absent services',async()=>{
 mocks.build.mockReturnValue(undefined);expect(await gatewayLifecycle(input,'update')).toEqual({ok:false,issue:'runtime_unavailable'});expect(mocks.install).not.toHaveBeenCalled();
 mocks.build.mockReturnValue({workspaceRoot:'/retained/core',digest});mocks.probe.mockResolvedValue({installed:false});expect(await gatewayLifecycle(input,'update')).toEqual({ok:false,issue:'runtime_unavailable'});expect(mocks.install).not.toHaveBeenCalled();
});
it('does not report success for a different runtime or unavailable startup',async()=>{
 vi.useFakeTimers();try{mocks.identity.mockResolvedValue('b'.repeat(64));const result=gatewayLifecycle(input,'update');await vi.advanceTimersByTimeAsync(16000);expect(await result).toEqual({ok:false,issue:'activation_failed'});}finally{vi.useRealTimers();}
});
