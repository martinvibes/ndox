import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
  /** Replace the data locally (after a mutation that returns the new value). */
  set: (v: T) => void;
}

/**
 * GET `path` (null = skip). Keeps the last good data while refreshing, so polling never
 * flashes an empty state; `refreshMs` polls while the tab is visible.
 */
export function useApi<T>(path: string | null, refreshMs?: number): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const lastPath = useRef(path);

  useEffect(() => {
    if (lastPath.current !== path) {
      lastPath.current = path;
      setData(undefined);
    }
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    api
      .get<T>(path, ctrl.signal)
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'network'));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, tick]);

  useEffect(() => {
    if (!refreshMs || path === null) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
    }, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, path]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, set: setData };
}
