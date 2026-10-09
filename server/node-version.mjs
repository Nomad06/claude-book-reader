// The reader server parses PDFs with pdf.js, which needs Node 22.13 or newer.
// Checked first thing at start, so an older node gets one clear line instead
// of a stack trace from inside pdf.js.

export const NODE_FLOOR = '22.13.0'

function parts(version) {
  return String(version)
    .replace(/^v/, '')
    .split('.')
    .map(n => Number(n) || 0)
}

/** null when `version` is at least `floor`, else the message to print. */
export function nodeVersionProblem(version = process.versions.node, floor = NODE_FLOOR) {
  const [a, b, c] = parts(version)
  const [x, y, z] = parts(floor)
  const isNewEnough = a > x || (a === x && (b > y || (b === y && c >= z)))
  const shortFloor = parts(floor).slice(0, 2).join('.')
  return isNewEnough ? null : `book-reader needs Node ${shortFloor} or newer; found v${parts(version).join('.')}`
}
