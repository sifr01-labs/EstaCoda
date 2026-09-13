import type {SettingField} from '../contracts/desktop-control/index.js';
/** Public model configuration fields, reviewed against runtime-config.ts and AuxiliaryModelSlotConfig. */
export const modelSettings:readonly SettingField[]=[
 ...['contextWindowTokens','maxTokens','timeoutMs','staleTimeoutMs'].map((key):SettingField=>({id:'model.fallbacks.#.'+key,path:['model','fallbacks','#',key],section:'models',kind:'number',min:1,max:10000000})),
 {id:'model.fallbacks.#.baseUrl',path:['model','fallbacks','#','baseUrl'],section:'models',kind:'text'},
 {id:'model.fallbacks.#.apiKeyEnv',path:['model','fallbacks','#','apiKeyEnv'],section:'models',kind:'secret'},
 {
  "id": "model.contextWindowTokens",
  "path": [
   "model",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "model.maxTokens",
  "path": [
   "model",
   "maxTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "model.timeoutMs",
  "path": [
   "model",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 1800000
 },
 {
  "id": "model.staleTimeoutMs",
  "path": [
   "model",
   "staleTimeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 1800000
 },
 {
  "id": "modelAliases.*.provider",
  "path": [
   "modelAliases",
   "*",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "modelAliases.*.model",
  "path": [
   "modelAliases",
   "*",
   "model"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "modelAliases.*.baseUrl",
  "path": [
   "modelAliases",
   "*",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "modelAliases.*.apiMode",
  "path": [
   "modelAliases",
   "*",
   "apiMode"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "modelAliases.*.apiKeyEnv",
  "path": [
   "modelAliases",
   "*",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "modelAliases.*.maxTokens",
  "path": [
   "modelAliases",
   "*",
   "maxTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "providers.*.kind",
  "path": [
   "providers",
   "*",
   "kind"
  ],
  "section": "models",
  "kind": "choice",
  "choices": [
   "openai-compatible",
   "catalog"
  ]
 },
 {
  "id": "providers.*.baseUrl",
  "path": [
   "providers",
   "*",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "providers.*.apiKeyEnv",
  "path": [
   "providers",
   "*",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "providers.*.apiMode",
  "path": [
   "providers",
   "*",
   "apiMode"
  ],
  "section": "models",
  "kind": "choice",
  "choices": [
   "openai_chat_completions",
   "openai_responses",
   "anthropic_messages",
   "custom_openai_compatible"
  ]
 },
 {
  "id": "providers.*.authMethod",
  "path": [
   "providers",
   "*",
   "authMethod"
  ],
  "section": "models",
  "kind": "choice",
  "choices": [
   "none",
   "api_key",
   "oauth_device",
   "oauth_device_pkce",
   "oauth_pkce_poll",
   "oauth_external"
  ]
 },
 {
  "id": "providers.*.models",
  "path": [
   "providers",
   "*",
   "models"
  ],
  "section": "models",
  "kind": "strings"
 },
 {
  "id": "providers.*.enableNetwork",
  "path": [
   "providers",
   "*",
   "enableNetwork"
  ],
  "section": "models",
  "kind": "choice",
  "choices": [
   false,
   true
  ]
 },
 {
  "id": "providers.*.timeoutMs",
  "path": [
   "providers",
   "*",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 1800000
 },
 {
  "id": "providers.*.staleTimeoutMs",
  "path": [
   "providers",
   "*",
   "staleTimeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 1800000
 },
 {
  "id": "providers.*.headerRefs.*",
  "path": [
   "providers",
   "*",
   "headerRefs",
   "*"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.default.provider",
  "path": [
   "auxiliaryModels",
   "default",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.default.id",
  "path": [
   "auxiliaryModels",
   "default",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.default.baseUrl",
  "path": [
   "auxiliaryModels",
   "default",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.default.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "default",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.default.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "default",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.default.timeoutMs",
  "path": [
   "auxiliaryModels",
   "default",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.default.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "default",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.default.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "default",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.default.enabled",
  "path": [
   "auxiliaryModels",
   "default",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.compression.provider",
  "path": [
   "auxiliaryModels",
   "compression",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.compression.id",
  "path": [
   "auxiliaryModels",
   "compression",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.compression.baseUrl",
  "path": [
   "auxiliaryModels",
   "compression",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.compression.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "compression",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.compression.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "compression",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.compression.timeoutMs",
  "path": [
   "auxiliaryModels",
   "compression",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.compression.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "compression",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.compression.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "compression",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.compression.enabled",
  "path": [
   "auxiliaryModels",
   "compression",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.assessor.provider",
  "path": [
   "auxiliaryModels",
   "assessor",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.assessor.id",
  "path": [
   "auxiliaryModels",
   "assessor",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.assessor.baseUrl",
  "path": [
   "auxiliaryModels",
   "assessor",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.assessor.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "assessor",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.assessor.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "assessor",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.assessor.timeoutMs",
  "path": [
   "auxiliaryModels",
   "assessor",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.assessor.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "assessor",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.assessor.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "assessor",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.assessor.enabled",
  "path": [
   "auxiliaryModels",
   "assessor",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.web_extract.provider",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.web_extract.id",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.web_extract.baseUrl",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.web_extract.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.web_extract.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.web_extract.timeoutMs",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.web_extract.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.web_extract.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.web_extract.enabled",
  "path": [
   "auxiliaryModels",
   "web_extract",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.session_search.provider",
  "path": [
   "auxiliaryModels",
   "session_search",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.session_search.id",
  "path": [
   "auxiliaryModels",
   "session_search",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.session_search.baseUrl",
  "path": [
   "auxiliaryModels",
   "session_search",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.session_search.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "session_search",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.session_search.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "session_search",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.session_search.timeoutMs",
  "path": [
   "auxiliaryModels",
   "session_search",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.session_search.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "session_search",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.session_search.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "session_search",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.session_search.enabled",
  "path": [
   "auxiliaryModels",
   "session_search",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.mcp.provider",
  "path": [
   "auxiliaryModels",
   "mcp",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.mcp.id",
  "path": [
   "auxiliaryModels",
   "mcp",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.mcp.baseUrl",
  "path": [
   "auxiliaryModels",
   "mcp",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.mcp.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "mcp",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.mcp.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "mcp",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.mcp.timeoutMs",
  "path": [
   "auxiliaryModels",
   "mcp",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.mcp.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "mcp",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.mcp.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "mcp",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.mcp.enabled",
  "path": [
   "auxiliaryModels",
   "mcp",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.memory_flush.provider",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.memory_flush.id",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.memory_flush.baseUrl",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.memory_flush.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.memory_flush.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.memory_flush.timeoutMs",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.memory_flush.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.memory_flush.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.memory_flush.enabled",
  "path": [
   "auxiliaryModels",
   "memory_flush",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.delegation.provider",
  "path": [
   "auxiliaryModels",
   "delegation",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.delegation.id",
  "path": [
   "auxiliaryModels",
   "delegation",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.delegation.baseUrl",
  "path": [
   "auxiliaryModels",
   "delegation",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.delegation.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "delegation",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.delegation.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "delegation",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.delegation.timeoutMs",
  "path": [
   "auxiliaryModels",
   "delegation",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.delegation.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "delegation",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.delegation.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "delegation",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.delegation.enabled",
  "path": [
   "auxiliaryModels",
   "delegation",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.skills_library.provider",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.skills_library.id",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.skills_library.baseUrl",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.skills_library.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.skills_library.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.skills_library.timeoutMs",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.skills_library.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.skills_library.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.skills_library.enabled",
  "path": [
   "auxiliaryModels",
   "skills_library",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.title_generation.provider",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.title_generation.id",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.title_generation.baseUrl",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.title_generation.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.title_generation.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.title_generation.timeoutMs",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.title_generation.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.title_generation.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.title_generation.enabled",
  "path": [
   "auxiliaryModels",
   "title_generation",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.curator.provider",
  "path": [
   "auxiliaryModels",
   "curator",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.curator.id",
  "path": [
   "auxiliaryModels",
   "curator",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.curator.baseUrl",
  "path": [
   "auxiliaryModels",
   "curator",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.curator.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "curator",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.curator.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "curator",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.curator.timeoutMs",
  "path": [
   "auxiliaryModels",
   "curator",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.curator.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "curator",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.curator.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "curator",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.curator.enabled",
  "path": [
   "auxiliaryModels",
   "curator",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.memory_compaction.provider",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.memory_compaction.id",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.memory_compaction.baseUrl",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.memory_compaction.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.memory_compaction.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.memory_compaction.timeoutMs",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.memory_compaction.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.memory_compaction.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.memory_compaction.enabled",
  "path": [
   "auxiliaryModels",
   "memory_compaction",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.profile_context.provider",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "provider"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.profile_context.id",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "id"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.profile_context.baseUrl",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "baseUrl"
  ],
  "section": "models",
  "kind": "text"
 },
 {
  "id": "auxiliaryModels.profile_context.apiKeyEnv",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "apiKeyEnv"
  ],
  "section": "models",
  "kind": "secret"
 },
 {
  "id": "auxiliaryModels.profile_context.contextWindowTokens",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "contextWindowTokens"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.profile_context.timeoutMs",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "timeoutMs"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 10000000
 },
 {
  "id": "auxiliaryModels.profile_context.maxConcurrency",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "maxConcurrency"
  ],
  "section": "models",
  "kind": "number",
  "min": 1,
  "max": 32
 },
 {
  "id": "auxiliaryModels.profile_context.fallbackToMain",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "fallbackToMain"
  ],
  "section": "models",
  "kind": "boolean"
 },
 {
  "id": "auxiliaryModels.profile_context.enabled",
  "path": [
   "auxiliaryModels",
   "profile_context",
   "enabled"
  ],
  "section": "models",
  "kind": "boolean"
 }
];
