import {useEffect, useRef, useState} from 'react';
import type {ActivityProjection, Page, WorkProjection} from '@estacoda/control-protocol';
import type {DesktopAdapter} from './adapter.js';

export const ACTIVITY_LIMIT = 2000;
/** Rebuild the inspected extent atomically with fresh, snapshot-bound cursors. */
export function useWorkActivity(adapter: DesktopAdapter, work: WorkProjection | undefined,
  extent: number, retainExtent: (count: number) => void) {
  const [activity, setActivity] = useState<Page<ActivityProjection>>({items: [], nextCursor: null});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0), busy = useRef(false), wanted = useRef(extent);
  wanted.current = extent;
  useEffect(() => {
    const current = ++generation.current;
    if (!work || adapter.fixture) return;
    busy.current = true; setLoading(true); setError('');
    const refresh = async () => {
      const page = await adapter.api.activity(work.id);
      while (current === generation.current && page.nextCursor && page.items.length < Math.min(wanted.current, ACTIVITY_LIMIT)) {
        const next = await adapter.api.activity(work.id, page.nextCursor);
        page.items.push(...next.items); page.nextCursor = next.nextCursor;
      }
      if (current === generation.current) setActivity(page);
    };
    void refresh().catch(() => {
      if (current === generation.current) setError('Activity could not be refreshed. Reopen Work to retry.');
    }).finally(() => { if (current === generation.current) {busy.current = false; setLoading(false);} });
    return () => { generation.current++; };
  }, [adapter, work]);
  const loadMore = async () => {
    if (!work || !activity.nextCursor || busy.current || activity.items.length >= ACTIVITY_LIMIT) return;
    const current = generation.current;
    busy.current = true; setLoading(true); setError('');
    try {
      const next = await adapter.api.activity(work.id, activity.nextCursor);
      if (current === generation.current) {
        const items = [...activity.items, ...next.items];
        wanted.current = items.length; retainExtent(items.length);
        setActivity({items, nextCursor: next.nextCursor});
      }
    } catch { if (current === generation.current) setError('History changed or disconnected. Reopen Work to retry.'); }
    finally { if (current === generation.current) {busy.current = false; setLoading(false);} }
  };
  return {activity, error, loading, loadMore};
}
