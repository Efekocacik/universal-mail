"use client";

import { useEffect, useState } from "react";

/** Değeri `ms` kadar sessizlikten sonra yansıtır (arama kutuları: her tuşta yeni sorgu başlamaz). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
