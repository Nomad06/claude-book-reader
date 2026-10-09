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
