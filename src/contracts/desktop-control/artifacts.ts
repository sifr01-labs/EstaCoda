export type ArtifactReference={source:'session'|'task';ownerId:string;artifactId:string};
export type ArtifactProjection={reference:ArtifactReference;displayName:string;mimeType:string;bytes:number;sha256:string;createdAt:string;retention:'retained'|'pruned'|'expired';sourceOrigin:string|null;workIds:string[];target:{targetId:string;targetGeneration:number}|null;sourceWorkspaceId?:string;applicationTargetId?:string;evidenceCallIds?:string[]};
export type ArtifactPreview={artifact:ArtifactProjection;integrity:'verified'|'unavailable';text:string|null;truncated:boolean;reason:string|null};
