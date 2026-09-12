import {resolveProfileStateHome} from '../config/profile-home.js';
import {readEnvSecretValue} from '../config/env-secret-store.js';
import {validateOAuthStore} from '../providers/oauth/oauth-store.js';
import {isOAuthAuthMethod} from '../providers/oauth/oauth-types.js';
import {getProviderMetadata} from '../providers/provider-metadata.js';
import type {LoadedRuntimeConfig} from '../config/runtime-config.js';
import type {ProviderAuthMethod, ProviderId} from '../contracts/provider.js';
import type {ModelProjection} from '../contracts/desktop-control/index.js';
import {readProfileFile} from './profile-attention.js';

/** Capture only the selected profile. Presence is not a network verification result. */
export async function captureCredentialPresence(loaded: LoadedRuntimeConfig) {
  const paths = resolveProfileStateHome(loaded);
  const [env, auth] = await Promise.all([
    readProfileFile(paths.profileRoot, paths.envPath), readProfileFile(paths.profileRoot, paths.authJsonPath),
  ]);
  const oauth = auth ? validateOAuthStore(JSON.parse(auth)) : undefined;
  if (oauth?.diagnostics.length) throw new Error('Provider authorization state needs repair');
  return (providerId: ProviderId, route?: {apiKeyEnv?: string; authMethod?: ProviderAuthMethod}): ModelProjection['credentialState'] => {
    const metadata = getProviderMetadata(providerId), provider = loaded.config.providers?.[providerId];
    const method = route?.authMethod ?? provider?.authMethod ?? metadata.defaultAuthMethod;
    if (isOAuthAuthMethod(method)) {
      const record = oauth?.store.providers[providerId];
      if (!record) return 'missing';
      if (record.expiresAt && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now())) return 'expired';
      return 'present';
    }
    if (method === 'none' && !route?.apiKeyEnv && !provider?.apiKeyEnv) return 'not_required';
    const key = route?.apiKeyEnv ?? provider?.apiKeyEnv ?? metadata.defaultApiKeyEnv;
    return key && Boolean((readEnvSecretValue(env ?? '', key) ?? process.env[key])?.trim()) ? 'present' : 'missing';
  };
}
