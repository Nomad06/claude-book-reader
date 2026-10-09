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
