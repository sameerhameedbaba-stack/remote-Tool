"use client";

import { useCallback, useEffect, useState } from "react";

// Client-side favorite devices, persisted in localStorage. A server-side
// address book (favorites, tags, groups) is a backend TODO — until then this
// gives technicians a real "pin your machines" affordance.
const KEY = "rs-favorites";

export function useFavorites() {
  const [ids, setIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setIds(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
  }, []);

  const persist = useCallback((next: Set<string>) => {
    setIds(new Set(next));
    try {
      localStorage.setItem(KEY, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
    },
    [ids, persist],
  );

  const isFavorite = useCallback((id: string) => ids.has(id), [ids]);

  return { favorites: ids, toggle, isFavorite };
}
