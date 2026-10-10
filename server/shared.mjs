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
 * What one POST /api/choose asks. `waitMs`: how long it waits for the dialog,
 * at most CHOOSE_WAIT_MAX_MS; undefined (wait for the outcome) without one, as
 * an older mod asks, or with one that is no number of milliseconds. `id`: the
 * dialog an earlier answer named, which the mod echoes.
 */
export function chooseRequest(body) {
  const waitMs = body?.waitMs
  const id = body?.id
  return {
    waitMs: Number.isFinite(waitMs) && waitMs >= 0 ? Math.min(waitMs, CHOOSE_WAIT_MAX_MS) : undefined,
    id: typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : undefined,
  }
}

/**
 * Work a caller waits on in pieces: Claude Code gives one request 30 s, and a
 * person may keep a file dialog open for minutes. `poll(waitMs, id)`:
 *
 * - without `id`, joins the work that runs, else starts it (`open()`): never
 *   hands it the outcome of earlier work, which nobody may be waiting for;
 * - with `id`, waits on that work; `{ gone: true }` when it is not this run's
 *   (another dialog since, a server restart) or its outcome was not collected
 *   within `keepMs` of settling.
 *
 * It answers the outcome once settled, else `{ pending: true, id }` after
 * `waitMs`; without `waitMs` (an older mod) it waits for the outcome.
 */
export function waitInPieces(open, { keepMs = 5_000, now = Date.now, newId = counter() } = {}) {
  let entry = null // { id, promise, outcome, settledAt }
  const start = () => {
    const started = { id: newId(), outcome: null, settledAt: 0 }
    let running
    try {
      running = Promise.resolve(open())
    } catch (error) {
      running = Promise.reject(error)
    }
    started.promise = running
      .then(
        value => ({ value }),
        error => ({ error }),
      )
      .then(outcome => {
        started.outcome = outcome
        started.settledAt = now()
        return outcome
      })
    return started
  }
  return async function poll(waitMs, id) {
    if (id !== undefined) {
      const isKept = entry?.id === id && (!entry.outcome || now() - entry.settledAt <= keepMs)
      if (!isKept) return { gone: true }
    } else if (!entry || entry.outcome) {
      entry = start()
    }
    const mine = entry
    let timer
    const outcome =
      mine.outcome ??
      (await (waitMs === undefined
        ? mine.promise
        : Promise.race([mine.promise, new Promise(resolve => (timer = setTimeout(resolve, waitMs, null)))])))
    clearTimeout(timer)
    if (!outcome) return { pending: true, id: mine.id }
    if (outcome.error) throw outcome.error
    return outcome.value
  }
}

function counter() {
  let n = 0
  return () => String(++n)
}
