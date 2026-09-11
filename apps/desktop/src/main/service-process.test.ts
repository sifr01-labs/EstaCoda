import { expect, it } from 'vitest';
import { validateProfileId, ownedRuntime } from './service-process.js';
it('rejects profile traversal, flags and noncanonical identities', () => {
  for (const id of ['../other', '--inspect', '', '..', 'a/b', 'a'.repeat(161), null]) expect(() => validateProfileId(id)).toThrow();
  expect(() => validateProfileId('personal-2')).not.toThrow();
});
it('fails closed without owned runtime metadata', () => {
  expect(() => ownedRuntime('/definitely-unavailable-runtime')).toThrow();
});
