// Work that runs once at a time per key: a request that arrives while the same
// work is running gets the running promise instead of starting its own.

/** `map` holds the running promises; the entry goes when the work settles. */
export function shared(map, key, work) {
  const known = map.get(key)
  if (known) return known
  const running = work().finally(() => map.delete(key))
  map.set(key, running)
  return running
}

/**
 * Whether a degraded answer for `key` (a figure that failed or ran out of
 * time) is left uncached for another try: true for the first `max` times,
 * then false (keep it like any answer) and the count goes. `counts` holds at
 * most `keep` keys, the oldest dropped first.
 */
export function tryAgain(counts, key, max, keep = 50) {
  const tries = counts.get(key) ?? 0
  counts.delete(key)
  if (tries >= max) return false
  counts.set(key, tries + 1)
  while (counts.size > keep) counts.delete(counts.keys().next().value)
  return true
}
