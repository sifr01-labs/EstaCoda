export type LibrarySkill={id:string;name:string;description:string;source:'local'|'bundled'|'external';version:string|null;requiredToolsets:string[];optionalToolsets:string[]};
export type LibrarySkillDetail={skill:LibrarySkill;instructions:string;truncated:boolean};
export type LibraryMemory={kind:'USER.md'|'SOUL.md'|'MEMORY.md';scope:'profile';content:string;truncated:boolean};
