// src/lib/autonomous/contextMonitor.ts
// Spec sections 16, 17, 18, 21, 23, 48.

export function contextRatio(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return 0;
  }
  const r = used / limit;
  if (r < 0) return 0;
  if (r > 1) return 1;
  return r;
}

// >= threshold triggers pending (spec 17). Equality counts so exactly 75% trips.
export function shouldMarkRolloverPending(
  used: number,
  limit: number,
  threshold: number
): boolean {
  if (limit <= 0) return false;
  return contextRatio(used, limit) >= threshold;
}

export function pct(used: number, limit: number): number {
  return Math.round(contextRatio(used, limit) * 100);
}
