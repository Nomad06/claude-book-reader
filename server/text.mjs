// Text that comes out of PDFs (titles, page text) is untrusted and ends up
// drawn in a terminal: no control character may reach it.

/** One line: line breaks become spaces, every other control character is dropped. */
export function plainText(text) {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** A run of page text: control characters dropped, spacing kept as it is. */
export function cleanRun(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** Outline entries with their nesting level held to `max`: deeper than that is no real contents. */
export function clampLevels(list, max = 9) {
  return list.map(entry => ({ ...entry, level: Math.min(entry.level, max) }))
}

/** An error's message as one short plain line: pdf.js messages can carry bytes of the PDF. */
export function errorLine(error, max = 300) {
  return plainText(String(error?.message ?? error)).slice(0, max)
}
