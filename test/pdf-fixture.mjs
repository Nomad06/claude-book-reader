// Builds small uncompressed PDFs for tests: one page per entry of `pages`,
// Helvetica (F1), Courier (F2) or Helvetica-Bold (F3), an outline entry per
// page that names one. Enough for pdf.js to give text items, fonts, an outline.
//
//   pages: [{ lines: [{ text, size?, font?, x?, y? }], outline?: string }]
//   A line whose text starts with four spaces is Courier unless `font` says otherwise.

/** The sample book the tests build their PDFs from: a heading, a hyphenated paragraph, code. */
export const TEXT = [
  {
    outline: 'Chapter One',
    lines: [
      { text: 'Chapter One', size: 18, font: 'F3' },
      { text: 'Hello world, this is body text.' },
      { text: 'Second line of the para-' },
      { text: 'graph continues here.' },
    ],
  },
  { outline: 'Chapter Two', lines: [{ text: '    const x = 1' }, { text: '      return x' }, { text: 'Plain again.' }] },
]

function finish(objects, catalogId) {
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

export function buildPdf(pages, { width = 612, height = 792 } = {}) {
  const objects = []
  const add = body => (objects.push(body), objects.length)
  const catalogId = add('')
  const pagesId = add('')
  const fonts = {
    F1: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    F2: add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
    F3: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
  }
  const resources = `/Resources << /Font << ${Object.entries(fonts)
    .map(([name, id]) => `/${name} ${id} 0 R`)
    .join(' ')} >> >>`

  const pageIds = []
  for (const page of pages) {
    let y = height - 72
    const ops = ['BT']
    for (const line of page.lines) {
      const size = line.size ?? 10
      const font = line.font ?? (line.text.startsWith('    ') ? 'F2' : 'F1')
      const at = line.y ?? y
      ops.push(`/${font} ${size} Tf 1 0 0 1 ${line.x ?? 72} ${at} Tm (${esc(line.text)}) Tj`)
      y = at - size * 1.4
    }
    ops.push('ET')
    const stream = ops.join('\n')
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
    pageIds.push(
      add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] ${resources} /Contents ${contentId} 0 R >>`),
    )
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`

  const entries = pages.map((page, i) => (page.outline ? { title: page.outline, pageId: pageIds[i] } : null)).filter(Boolean)
  let outlinesId = null
  if (entries.length > 0) {
    outlinesId = add('')
    const itemIds = entries.map(() => add(''))
    entries.forEach((entry, i) => {
      const prev = i > 0 ? ` /Prev ${itemIds[i - 1]} 0 R` : ''
      const next = i < entries.length - 1 ? ` /Next ${itemIds[i + 1]} 0 R` : ''
      const dest = entry.title === 'NOWHERE' ? '' : ` /Dest [${entry.pageId} 0 R /XYZ 0 ${height} 0]`
      objects[itemIds[i] - 1] = `<< /Title (${esc(entry.title)}) /Parent ${outlinesId} 0 R${prev}${next}${dest} >>`
    })
    objects[outlinesId - 1] = `<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds.at(-1)} 0 R /Count ${itemIds.length} >>`
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlinesId ? ` /Outlines ${outlinesId} 0 R` : ''} >>`
  return finish(objects, catalogId)
}

/**
 * A PDF whose pages each show only a mid-gray RGB image covering the page. All
 * pages share the one image object, as a book's repeated logo or rule does.
 */
export function buildScannedPdf({ width = 612, height = 792, pixels = 32, copies = 1, pages = 1 } = {}) {
  const objects = []
  const add = body => (objects.push(body), objects.length)
  const catalogId = add('')
  const pagesId = add('')
  const raw = Buffer.alloc(pixels * pixels * 3, 0x80)
  const imageId = add(
    `<< /Type /XObject /Subtype /Image /Width ${pixels} /Height ${pixels} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${raw.length} >>\nstream\n${raw.toString('latin1')}\nendstream`,
  )
  const stream = Array.from({ length: copies }, () => `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`).join('\n')
  const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  const pageIds = Array.from({ length: pages }, () =>
    add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ),
  )
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages} >>`
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  return finish(objects, catalogId)
}

/**
 * One page with a figure drawn with paths: a line of text, a filled gray box
 * (150..350 × 500..620) inside a stroked black frame (120..380 × 480..640), a
 * clipping rectangle that paints nothing, then "Figure 1. A box." and a line
 * below. Helvetica, 10 pt. `strokes` adds that many wide curves across the box:
 * a figure slow to render; `skew` slants the text (a fake italic).
 */
export function buildDrawingPdf({ width = 612, height = 792, strokes = 0, skew = 0 } = {}) {
  const objects = []
  const add = body => (objects.push(body), objects.length)
  const catalogId = add('')
  const pagesId = add('')
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const text = (y, s) => `BT /F1 10 Tf 1 0 ${skew} 1 72 ${y} Tm (${esc(s)}) Tj ET`
  const stream = [
    text(700, 'Some text above the figure.'),
    `q 0 0 ${width} ${height} re W n Q`,
    'q 0.3 g 150 500 200 120 re f Q',
    'q 0 G 2 w 120 480 260 160 re S Q',
    ...Array.from({ length: strokes }, (_, i) => `q 0.5 G 9 w 1 J 130 ${490 + (i % 140)} m 200 640 300 480 370 ${630 - (i % 140)} c S Q`),
    text(450, 'Figure 1. A box.'),
    text(430, 'Text below the figure.'),
  ].join('\n')
  const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  const pageId = add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
  )
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  return finish(objects, catalogId)
}
