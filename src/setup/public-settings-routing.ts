import type { SettingField } from '../contracts/desktop-control/index.js';
/** Same protected credential and review/apply path as voice and vision models. */
export const routingSettings: readonly SettingField[] = [
  { id: 'routing.mode', path: ['routing', 'mode'], section: 'runtime', kind: 'choice', choices: ['standard', 'jev-assisted'] },
  { id: 'routing.jev.provider', path: ['routing', 'jev', 'provider'], section: 'runtime', kind: 'choice', choices: ['typesafe'] },
  { id: 'routing.jev.id', path: ['routing', 'jev', 'id'], section: 'runtime', kind: 'text' },
  { id: 'routing.jev.apiKeyEnv', path: ['routing', 'jev', 'apiKeyEnv'], section: 'runtime', kind: 'secret' },
  { id: 'routing.jev.timeoutMs', path: ['routing', 'jev', 'timeoutMs'], section: 'runtime', kind: 'number', min: 100, max: 60000 },
];
