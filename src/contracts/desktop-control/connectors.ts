/** Selected-profile connector metadata; no command, endpoint, credential or raw error. */
export type ConnectorStatus = {
  state: 'not_loaded' | 'ready' | 'reconnecting' | 'busy' | 'failed' | 'unavailable';
  items: Array<{ id: string; state: 'not_loaded' | 'ready' | 'disabled' | 'needs_attention'; toolCount: number }>;
};
