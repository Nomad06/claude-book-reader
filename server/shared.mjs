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

/** Under the 30 s Claude Code gives one request. */
export const CHOOSE_WAIT_MAX_MS = 25_000

/**
 * How long one POST /api/choose waits for the dialog: the mod's `waitMs`, at
 * most CHOOSE_WAIT_MAX_MS; undefined (wait for the outcome) without one, as an
 * older mod asks, or with one that is no number of milliseconds.
 */
export function chooseWait(body) {
  const waitMs = body?.waitMs
  return Number.isFinite(waitMs) && waitMs >= 0 ? Math.min(waitMs, CHOOSE_WAIT_MAX_MS) : undefined
}

/**
 * Work a caller waits on in pieces: Claude Code gives one request 30 s, and a
 * person may keep a file dialog open for minutes. `poll(waitMs)` starts the
 * work (`open()`) unless it runs, then answers its outcome once settled, or
 * `{ pending: true }` after `waitMs`; without `waitMs` (an older mod) it waits
 * for the outcome. Polls while it runs share it. The outcome goes to the polls
 * waiting when it settles, else to the next one; one nobody collects within
 * `keepMs` is dropped, so a later poll starts the work again.
 */
export function waitInPieces(open, { keepMs = 60_000, now = Date.now } = {}) {
  let running = null // { promise, outcome, settledAt }
  return async function poll(waitMs) {
    if (running?.outcome && now() - running.settledAt > keepMs) running = null
    if (!running) {
      const entry = { outcome: null, settledAt: 0 }
      let started
      try {
        started = Promise.resolve(open())
      } catch (error) {
        started = Promise.reject(error)
      }
      entry.promise = started
        .then(
          value => ({ value }),
          error => ({ error }),
        )
        .then(outcome => {
          entry.outcome = outcome
          entry.settledAt = now()
          return outcome
        })
      running = entry
    }
    const entry = running
    let timer
    const outcome =
      entry.outcome ??
      (await (waitMs === undefined
        ? entry.promise
        : Promise.race([entry.promise, new Promise(resolve => (timer = setTimeout(resolve, waitMs, null)))])))
    clearTimeout(timer)
    if (!outcome) return { pending: true }
    if (running === entry) running = null
    if (outcome.error) throw outcome.error
    return outcome.value
  }
}
