"use client";

import { useEffect } from "react";

/** Stamps tf_seen = this render's timestamp AFTER mount — the feed was
 *  already built from the previous value, so writing pre-render would
 *  swallow the visit's own new items. */
export default function SeenMarker({ at }: { at: number }) {
  useEffect(() => {
    document.cookie = `tf_seen=${at}; path=/; max-age=31536000; samesite=lax`;
  }, [at]);
  return null;
}
