// Book Reader viewer: pdf.js components plus reading progress, read-page
// tracking and the task events the Claude Code mod relays through the server.

import * as pdfjsLib from './vendor/pdfjs/build/pdf.min.mjs'

const VENDOR = new URL('./vendor/pdfjs/', import.meta.url).href
pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}build/pdf.worker.min.mjs`
globalThis.pdfjsLib = pdfjsLib
const { EventBus, PDFLinkService, PDFFindController, PDFViewer } = await import('./vendor/pdfjs/web/pdf_viewer.mjs')

const el = id => document.getElementById(id)
const container = el('viewerContainer')
const pageInput = el('pageInput')
const zoomSelect = el('zoomSelect')
const doneDialog = el('doneDialog')
const helpDialog = el('helpDialog')
const findInput = el('findInput')

const AWAY_AFTER_MS = 3 * 60_000
const READ_VIEW_SHARE = 0.5
const READ_PAGE_SHARE = 0.6

// ---------------------------------------------------------------- pdf.js

const eventBus = new EventBus()
const linkService = new PDFLinkService({ eventBus })
const findController = new PDFFindController({ eventBus, linkService })
const pdfViewer = new PDFViewer({
  container,
  viewer: el('viewer'),
  eventBus,
  linkService,
  findController,
  imageResourcesPath: `${VENDOR}web/images/`,
})
linkService.setViewer(pdfViewer)

// ---------------------------------------------------------------- state

let book = null // the server's record of the open book
let pdfDoc = null
let loadingTask = null
let restored = false
let readSet = new Set()
const pendingRead = new Set()
const pendingUnread = new Set()
let pendingMeta = {}
const dwell = new Map()
let settings = { theme: 'light', readSeconds: 6 }
let task = null
let lastInputAt = Date.now()
let library = []
let outlinePages = []
let flashTimer = null

const viewerId = (() => {
  try {
    const saved = sessionStorage.getItem('book-reader:vid')
    if (saved) return saved
    const fresh = crypto.randomUUID()
    sessionStorage.setItem('book-reader:vid', fresh)
    return fresh
  } catch {
    return crypto.randomUUID()
  }
})()

// ---------------------------------------------------------------- helpers

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

function local(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`book-reader:${key}`)
    localStorage.setItem(`book-reader:${key}`, value)
  } catch {}
  return null
}

let toastTimer = null
function toast(text, ms = 2600) {
  const box = el('toast')
  box.textContent = text
  box.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (box.hidden = true), ms)
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function numPages() {
  return pdfDoc?.numPages ?? book?.pages ?? 0
}

function currentPage() {
  return pdfDoc ? pdfViewer.currentPageNumber : (book?.page ?? 1)
}

function focusReader() {
  container.focus({ preventScroll: true })
}

// ---------------------------------------------------------------- open a book

async function openBook(id) {
  await flushProgress()
  let record
  try {
    record = await api('GET', `/api/books/${id}`)
  } catch (error) {
    toast(`Could not open the book: ${error.message}`)
    return
  }
  book = record
  readSet = new Set(book.read ?? [])
  dwell.clear()
  restored = false
  outlinePages = []
  el('empty').hidden = true
  el('closedNote').hidden = true
  el('bookTitle').textContent = book.title
  el('bookTitle').title = book.path
  updateReadUi()

  if (loadingTask) await loadingTask.destroy().catch(() => {})
  pdfDoc = null
  loadingTask = pdfjsLib.getDocument({
    url: `/api/books/${id}/pdf`,
    cMapUrl: `${VENDOR}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${VENDOR}standard_fonts/`,
    wasmUrl: `${VENDOR}wasm/`,
    iccUrl: `${VENDOR}iccs/`,
  })
  const thisLoad = loadingTask
  let doc
  try {
    doc = await thisLoad.promise
  } catch (error) {
    if (thisLoad !== loadingTask) return
    toast(`Could not read the PDF: ${error.message}`, 6000)
    showEmpty(`Could not read “${book.title}”. Was the file moved?`)
    return
  }
  if (thisLoad !== loadingTask) return
  pdfDoc = doc
  pdfViewer.setDocument(doc)
  linkService.setDocument(doc, null)
  el('pageCount').textContent = doc.numPages
  pageInput.max = doc.numPages
  pageInput.value = 1
  pendingMeta.pages = doc.numPages

  try {
    const meta = await doc.getMetadata()
    const title = meta?.info?.Title?.trim()
    if (title && title.length > 2 && !/^(untitled|microsoft word|document\d*)/i.test(title)) {
      pendingMeta.title = title
      book.title = title
      el('bookTitle').textContent = title
    }
  } catch {}

  scheduleProgress(300)
  renderPageGrid()
  renderOutline()
  renderLibrary()
  updateReadUi()
  setTitle()
}

function showEmpty(message) {
  el('empty').hidden = false
  if (message) el('empty').querySelector('h1').textContent = message
  el('bookTitle').textContent = 'Book Reader'
  document.title = 'Book Reader'
}

async function unloadBook() {
  await flushProgress()
  if (loadingTask) await loadingTask.destroy().catch(() => {})
  loadingTask = null
  pdfDoc = null
  book = null
  pdfViewer.setDocument(null)
  linkService.setDocument(null, null)
  showEmpty()
}

eventBus.on('pagesinit', () => {
  pdfViewer.currentScaleValue = local('zoom') || 'auto'
  if (book?.location) {
    linkService.setHash(book.location.replace(/^#/, ''))
  } else if (book?.page > 1) {
    pdfViewer.currentPageNumber = book.page
  }
  requestAnimationFrame(() => {
    restored = true
    pageInput.value = pdfViewer.currentPageNumber
    updateReadUi()
    markGridCurrent()
    setTitle()
    focusReader()
    if (book?.page > 1) toast(`Welcome back — page ${book.page} of ${numPages()}`)
  })
})

eventBus.on('pagechanging', ({ pageNumber }) => {
  pageInput.value = pageNumber
  updateReadUi()
  markGridCurrent()
  setTitle()
})

eventBus.on('updateviewarea', ({ location }) => {
  if (!restored || !book) return
  book.location = location.pdfOpenParams
  book.page = location.pageNumber
  scheduleProgress()
})

eventBus.on('scalechanging', ({ scale, presetValue }) => {
  const preset = presetValue ?? String(scale)
  const option = [...zoomSelect.options].find(o => o.value === preset && !o.disabled)
  const custom = el('zoomCustom')
  if (option) {
    custom.hidden = true
    zoomSelect.value = preset
  } else {
    custom.hidden = false
    custom.textContent = `${Math.round(scale * 100)}%`
    zoomSelect.value = 'custom'
  }
  if (restored) local('zoom', presetValue ?? String(scale))
})

// Keep preset zooms (auto, page-width, page-fit) right when the window or sidebar changes size.
let resizeTimer = null
new ResizeObserver(() => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    const value = pdfViewer.currentScaleValue
    if (pdfDoc && typeof value === 'string' && isNaN(Number(value))) pdfViewer.currentScaleValue = value
  }, 120)
}).observe(container)

// ---------------------------------------------------------------- progress

let progressTimer = null
function scheduleProgress(delay = 1000) {
  clearTimeout(progressTimer)
  progressTimer = setTimeout(flushProgress, delay)
}

function progressBody() {
  return {
    location: book?.location ?? undefined,
    page: book?.page,
    read: [...pendingRead],
    unread: [...pendingUnread],
    ...pendingMeta,
  }
}

async function flushProgress() {
  clearTimeout(progressTimer)
  if (!book) return
  const id = book.id
  const body = progressBody()
  pendingRead.clear()
  pendingUnread.clear()
  pendingMeta = {}
  try {
    await api('POST', `/api/books/${id}/progress`, body)
  } catch {
    body.read.forEach(p => pendingRead.add(p))
    body.unread.forEach(p => pendingUnread.add(p))
  }
}

window.addEventListener('pagehide', () => {
  if (!book) return
  const blob = new Blob([JSON.stringify(progressBody())], { type: 'application/json' })
  navigator.sendBeacon(`/api/books/${book.id}/progress`, blob)
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushProgress()
})

// ---------------------------------------------------------------- read pages

for (const type of ['keydown', 'wheel', 'pointerdown', 'pointermove', 'scroll']) {
  window.addEventListener(type, () => (lastInputAt = Date.now()), { capture: true, passive: true })
}

// A page counts as read once it has filled most of the view for `readSeconds`
// while the window is visible and you have not walked away.
setInterval(() => {
  if (!pdfDoc || !restored || document.visibilityState !== 'visible') return
  if (Date.now() - lastInputAt > AWAY_AFTER_MS) return
  const view = container.getBoundingClientRect()
  const current = pdfViewer.currentPageNumber
  for (let p = Math.max(1, current - 2); p <= Math.min(pdfDoc.numPages, current + 3); p++) {
    const div = pdfViewer.getPageView(p - 1)?.div
    if (!div) continue
    const r = div.getBoundingClientRect()
    const shown = Math.max(0, Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top))
    if (r.height === 0) continue
    if (shown / r.height >= READ_PAGE_SHARE || shown / view.height >= READ_VIEW_SHARE) {
      const seconds = (dwell.get(p) ?? 0) + 1
      dwell.set(p, seconds)
      if (seconds >= settings.readSeconds && !readSet.has(p)) setRead(p, true)
    }
  }
}, 1000)

function setRead(page, isRead) {
  if (isRead) {
    readSet.add(page)
    pendingRead.add(page)
    pendingUnread.delete(page)
  } else {
    readSet.delete(page)
    pendingUnread.add(page)
    pendingRead.delete(page)
    dwell.set(page, -Infinity) // stays unread until you reopen the book
  }
  updateReadUi()
  updateGridCell(page)
  updateOutlineRead()
  scheduleProgress(1200)
}

function updateReadUi() {
  const total = numPages()
  const page = currentPage()
  el('readLabel').textContent = `${readSet.size} / ${total || '–'} read`
  el('markRead').classList.toggle('is-read', readSet.has(page))
  el('markRead').title = readSet.has(page) ? 'Page read — press m to mark unread' : 'Mark this page read (m)'
  el('progressBar').style.width = total ? `${(100 * readSet.size) / total}%` : '0'
}

function firstUnread() {
  for (let p = 1; p <= numPages(); p++) if (!readSet.has(p)) return p
  return null
}

function goToPage(n) {
  if (!pdfDoc) return
  pdfViewer.currentPageNumber = Math.min(Math.max(1, n), pdfDoc.numPages)
}

// ---------------------------------------------------------------- sidebar

function renderPageGrid() {
  const grid = el('pageGrid')
  const frag = document.createDocumentFragment()
  for (let p = 1; p <= numPages(); p++) {
    const b = document.createElement('button')
    b.textContent = p
    b.dataset.page = p
    if (readSet.has(p)) b.classList.add('read')
    frag.append(b)
  }
  grid.replaceChildren(frag)
  markGridCurrent()
}

function updateGridCell(page) {
  el('pageGrid').querySelector(`[data-page="${page}"]`)?.classList.toggle('read', readSet.has(page))
}

function markGridCurrent() {
  const grid = el('pageGrid')
  grid.querySelector('.cur')?.classList.remove('cur')
  grid.querySelector(`[data-page="${currentPage()}"]`)?.classList.add('cur')
}

el('pageGrid').addEventListener('click', e => {
  const page = Number(e.target.closest('button')?.dataset.page)
  if (page) goToPage(page)
})

async function renderOutline() {
  const box = el('outline')
  const doc = pdfDoc
  const outline = await doc.getOutline().catch(() => null)
  if (doc !== pdfDoc) return
  if (!outline?.length) {
    box.innerHTML = '<p class="muted">No table of contents in this book.</p>'
    reportOutline([])
    return
  }
  const entries = [] // in reading order: { a, level, page }
  const build = (items, level) => {
    const ul = document.createElement('ul')
    for (const item of items) {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = '#'
      a.textContent = item.title || '(untitled)'
      a.title = item.title
      a.addEventListener('click', e => {
        e.preventDefault()
        if (item.dest) linkService.goToDestination(item.dest)
        else if (item.url) window.open(item.url, '_blank', 'noopener')
      })
      const entry = { a, level, page: null }
      entries.push(entry)
      li.append(a)
      if (item.items?.length) li.append(build(item.items, level + 1))
      ul.append(li)
      entry.resolving = resolvePage(doc, item.dest).then(page => (entry.page = page))
    }
    return ul
  }
  box.replaceChildren(build(outline, 0))
  await Promise.all(entries.map(entry => entry.resolving))
  if (doc !== pdfDoc) return
  outlinePages = entries.filter(entry => entry.page)
  updateOutlineRead()
  reportOutline(outlinePages)
}

// Tells the server the contents, so the dock in Claude Code can list chapters.
// Sent once per book: skipped when the server already has the same list.
function reportOutline(entries) {
  if (!book) return
  const outline = entries.slice(0, 2000).map(entry => ({
    title: (entry.a.title || entry.a.textContent || '').trim().slice(0, 200) || '(untitled)',
    page: entry.page,
    level: Math.min(entry.level, 9),
  }))
  if (JSON.stringify(outline) === JSON.stringify(book.outline ?? null)) return
  const id = book.id
  api('POST', `/api/books/${id}/outline`, { outline })
    .then(() => {
      if (book?.id === id) book.outline = outline
    })
    .catch(() => {})
}

async function resolvePage(doc, dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit)) return null
    const ref = explicit[0]
    return typeof ref === 'object' && ref !== null ? (await doc.getPageIndex(ref)) + 1 : Number(ref) + 1
  } catch {
    return null
  }
}

// A section counts as read when every page from its start up to the next
// section at its level or above is read.
function updateOutlineRead() {
  const last = numPages()
  outlinePages.forEach((entry, i) => {
    const next = outlinePages.slice(i + 1).find(other => other.level <= entry.level && other.page > entry.page)
    const end = Math.max(entry.page, (next?.page ?? last + 1) - 1)
    let isRead = true
    for (let p = entry.page; p <= end && isRead; p++) isRead = readSet.has(p)
    entry.a.classList.toggle('is-read', isRead)
    entry.a.dataset.page = entry.page
  })
}

async function refreshLibrary() {
  try {
    const state = await api('GET', '/api/state')
    library = state.books
    renderLibrary()
    return state
  } catch {
    return null
  }
}

function renderLibrary() {
  for (const list of [el('library'), el('emptyLibrary')]) {
    const frag = document.createDocumentFragment()
    for (const b of library) {
      const li = document.createElement('li')
      li.dataset.id = b.id
      if (b.id === book?.id) li.classList.add('current')
      const pct = b.pages ? Math.round((100 * b.readCount) / b.pages) : 0
      li.innerHTML = '<span class="name"></span><button class="remove" title="Remove from library (the file stays)">✕</button><span class="meta"></span><span class="bar"><i></i></span>'
      li.querySelector('.name').textContent = b.title
      li.querySelector('.name').title = b.path
      li.querySelector('.meta').textContent = b.pages ? `p. ${b.page} of ${b.pages} · ${pct}% read` : 'not opened yet'
      li.querySelector('.bar > i').style.width = `${pct}%`
      frag.append(li)
    }
    list.replaceChildren(frag)
  }
}

for (const list of [el('library'), el('emptyLibrary')]) {
  list.addEventListener('click', async e => {
    const li = e.target.closest('li')
    if (!li) return
    if (e.target.closest('.remove')) {
      const b = library.find(x => x.id === li.dataset.id)
      if (b && confirm(`Remove “${b.title}” from the library? The PDF file is not deleted.`)) {
        await api('DELETE', `/api/books/${b.id}`).catch(err => toast(err.message))
      }
      return
    }
    if (li.dataset.id !== book?.id) await api('POST', `/api/books/${li.dataset.id}/select`).catch(err => toast(err.message))
  })
}

async function chooseBook() {
  toast('Choose a PDF in the dialog…', 4000)
  try {
    const res = await api('POST', '/api/choose')
    if (res.cancelled) toast('No book chosen')
  } catch (error) {
    toast(error.message, 5000)
  }
}

function setSidebar(open) {
  el('sidebar').hidden = !open
  document.body.classList.toggle('sidebar-open', open)
  local('sidebar', open ? '1' : '0')
}

function setTab(name) {
  for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name))
  }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name
  local('tab', name)
  if (name === 'library') refreshLibrary()
  if (name === 'pages') el('pageGrid').querySelector('.cur')?.scrollIntoView({ block: 'center' })
}

// ---------------------------------------------------------------- find

function openFind() {
  el('findbar').hidden = false
  findInput.focus()
  findInput.select()
}

function closeFind() {
  el('findbar').hidden = true
  eventBus.dispatch('findbarclose', { source: null })
  focusReader()
}

function find(type, findPrevious = false) {
  eventBus.dispatch('find', {
    source: null,
    type,
    query: findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  })
}

function showMatches({ matchesCount, state }) {
  const total = matchesCount?.total ?? 0
  el('findCount').textContent = !findInput.value ? '' : total ? `${matchesCount.current} of ${total}` : state === 1 ? 'No matches' : '…'
}
eventBus.on('updatefindmatchescount', showMatches)
eventBus.on('updatefindcontrolstate', showMatches)

findInput.addEventListener('input', () => find(''))
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault()
    find('again', e.shiftKey)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind()
  }
})
el('findPrev').onclick = () => find('again', true)
el('findNext').onclick = () => find('again', false)
el('findClose').onclick = closeFind
el('findToggle').onclick = () => (el('findbar').hidden ? openFind() : closeFind())

// ---------------------------------------------------------------- theme

const THEMES = ['light', 'sepia', 'dark']
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  local('theme', theme)
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length]
  settings.theme = next
  applyTheme(next)
  api('POST', '/api/settings', { theme: next }).catch(() => {})
  toast(`Theme: ${next}`, 1200)
}

// ---------------------------------------------------------------- task events

function renderTaskChip() {
  const chip = el('taskChip')
  el('toClaude').hidden = !task?.canReturn
  if (!task || task.state === 'idle') {
    chip.hidden = true
    return
  }
  chip.hidden = false
  chip.className = `chip ${task.state}`
  if (task.state === 'running') {
    const elapsed = task.startedAt ? fmtDuration(Date.now() - task.startedAt) : ''
    chip.textContent = `Claude is working ${elapsed}`
    chip.title = 'Claude is still on the task; this book closes when you say so.'
  } else if (task.state === 'done') {
    chip.textContent = 'Task finished'
    chip.title = 'Click for options'
  } else {
    chip.textContent = task.state === 'aborted' ? 'Task stopped' : 'Task hit an error'
    chip.title = 'Click for options'
  }
}
setInterval(() => task?.state === 'running' && renderTaskChip(), 1000)
el('taskChip').addEventListener('click', () => task && task.state !== 'running' && showDone(task))

function onTask(next) {
  const previous = task
  task = next
  renderTaskChip()
  if (next.state === 'running') {
    if (doneDialog.open) doneDialog.close('silent')
    el('closedNote').hidden = true
    setTitle()
    return
  }
  const ended = ['done', 'aborted', 'error'].includes(next.state)
  if (ended && !next.acked && previous?.seq !== next.seq && previous?.state === 'running') showDone(next)
  if (next.acked && doneDialog.open) doneDialog.close('silent')
}

function showDone(t) {
  const isDone = t.state === 'done'
  el('doneIcon').textContent = isDone ? '✓' : '■'
  el('doneIcon').classList.toggle('stopped', !isDone)
  el('doneTitle').textContent = isDone ? 'Claude finished the task' : t.state === 'aborted' ? 'Claude stopped the task' : 'Claude hit an error'
  el('doneMeta').textContent = t.durationMs ? `It took ${fmtDuration(t.durationMs)}.` : ''
  const summary = (t.summary || '').trim()
  el('doneSummary').hidden = !summary
  el('doneSummary').textContent = summary.length > 400 ? `${summary.slice(0, 400)}…` : summary
  el('doneWhere').textContent = pdfDoc
    ? `You are on page ${currentPage()} of ${numPages()} · ${readSet.size} pages read. Your place is saved either way.`
    : ''
  el('switchToClaude').hidden = !t.canReturn
  el('closeBook').title = t.canReturn ? 'Closes the book and takes you back to Claude' : 'Closes the book; your place is kept'
  if (!doneDialog.open) doneDialog.showModal()
  el('keepReading').focus()
  document.title = `✓ Task finished — ${book?.title ?? 'Book Reader'}`
  flashTitle('✓ Claude is done')
}

doneDialog.addEventListener('close', () => {
  const choice = doneDialog.returnValue
  doneDialog.returnValue = ''
  setTitle()
  if (choice === 'silent') return
  if (choice === 'close') {
    closeBook(true)
    return
  }
  if (choice === 'claude') {
    switchToClaude()
    return
  }
  api('POST', '/api/task', { state: 'ack' }).catch(() => {})
  focusReader()
})

/** Brings the Claude Code session to the front; the book stays open behind it. */
async function switchToClaude() {
  await flushProgress()
  const result = await api('POST', '/api/focus').catch(() => ({ focused: false }))
  if (!result.focused) toast('Could not switch to Claude: use your app switcher', 4000)
}
el('toClaude').onclick = switchToClaude

async function closeBook(fromHere) {
  if (doneDialog.open) doneDialog.close('silent')
  await flushProgress()
  // The server switches to Claude, then closes this window: a page may not
  // close a window the browser opened.
  if (fromHere) await api('POST', '/api/close', { focus: true }).catch(() => {})
  window.close()
  // A window the browser will not let a script close: say the place is kept.
  setTimeout(() => {
    el('closedWhere').textContent = book ? `“${book.title}”, page ${currentPage()} of ${numPages()}.` : ''
    el('closedNote').hidden = false
  }, 300)
}
el('reopen').onclick = () => {
  el('closedNote').hidden = true
  focusReader()
}

function setTitle() {
  if (!book) return
  document.title = pdfDoc ? `${book.title} — p. ${currentPage()}/${numPages()}` : book.title
}

function flashTitle(text) {
  clearInterval(flashTimer)
  let n = 0
  flashTimer = setInterval(() => {
    n++
    if (n > 8 || document.hasFocus()) {
      clearInterval(flashTimer)
      if (!doneDialog.open) setTitle()
      return
    }
    document.title = n % 2 ? text : `📖 ${book?.title ?? 'Book Reader'}`
  }, 900)
}

// ---------------------------------------------------------------- events from the server

function connect() {
  const source = new EventSource(`/api/events?vid=${encodeURIComponent(viewerId)}`)
  source.onmessage = event => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    handle(message)
  }
}

async function handle(message) {
  switch (message.type) {
    case 'hello': {
      const state = message.state
      settings = { ...settings, ...state.settings }
      applyTheme(settings.theme)
      el('readSeconds').value = String(settings.readSeconds)
      library = state.books
      task = state.task
      renderTaskChip()
      renderLibrary()
      if (!state.current) {
        if (book) await unloadBook()
        else showEmpty()
      } else if (state.current.id !== book?.id) {
        await openBook(state.current.id)
      }
      break
    }
    case 'book': {
      if (message.reset && message.id === book?.id) {
        readSet = new Set()
        dwell.clear()
        renderPageGrid()
        updateReadUi()
        updateOutlineRead()
      } else if (message.id !== book?.id) {
        await openBook(message.id)
      }
      refreshLibrary()
      break
    }
    case 'library': {
      const state = await refreshLibrary()
      if (state && !state.current && book) await unloadBook()
      break
    }
    case 'task':
      onTask(message.task)
      break
    case 'close':
      closeBook(false)
      break
    case 'goto':
      if (message.id === book?.id) {
        el('closedNote').hidden = true
        goToPage(message.page)
      }
      break
    case 'attention':
      el('closedNote').hidden = true
      flashTitle('📖 Claude is working — read on')
      toast('Claude is working — happy reading')
      break
  }
}

// ---------------------------------------------------------------- controls

el('sidebarToggle').onclick = () => setSidebar(el('sidebar').hidden)
for (const tab of document.querySelectorAll('.tabs [role="tab"]')) tab.onclick = () => setTab(tab.dataset.tab)
el('prevPage').onclick = () => pdfViewer.previousPage()
el('nextPage').onclick = () => pdfViewer.nextPage()
el('zoomIn').onclick = () => pdfViewer.increaseScale()
el('zoomOut').onclick = () => pdfViewer.decreaseScale()
zoomSelect.onchange = () => {
  if (zoomSelect.value !== 'custom') pdfViewer.currentScaleValue = zoomSelect.value
  focusReader()
}
pageInput.addEventListener('change', () => {
  goToPage(Number(pageInput.value) || 1)
  focusReader()
})
pageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    goToPage(Number(pageInput.value) || 1)
    focusReader()
  } else if (e.key === 'Escape') {
    pageInput.value = currentPage()
    focusReader()
  }
})
el('markRead').onclick = () => pdfDoc && setRead(currentPage(), !readSet.has(currentPage()))
el('themeToggle').onclick = cycleTheme
el('helpToggle').onclick = () => helpDialog.showModal()
helpDialog.addEventListener('close', focusReader)
el('chooseBook').onclick = chooseBook
el('chooseBook2').onclick = chooseBook
el('firstUnread').onclick = () => {
  const p = firstUnread()
  p ? goToPage(p) : toast('Every page is read 🎉')
}
el('readSeconds').onchange = () => {
  settings.readSeconds = Number(el('readSeconds').value)
  api('POST', '/api/settings', { readSeconds: settings.readSeconds }).catch(() => {})
}
el('resetProgress').onclick = async () => {
  if (book && confirm(`Forget which pages of “${book.title}” you have read?`)) {
    await flushProgress()
    await api('POST', `/api/books/${book.id}/reset`).catch(err => toast(err.message))
  }
}

let wheelScale = 1
container.addEventListener(
  'wheel',
  e => {
    if (!(e.ctrlKey || e.metaKey) || !pdfDoc) return
    e.preventDefault()
    wheelScale *= Math.exp(-e.deltaY / 200)
    if (Math.abs(Math.log(wheelScale)) < 0.02) return
    pdfViewer.updateScale({ drawingDelay: 300, scaleFactor: wheelScale, origin: [e.clientX, e.clientY] })
    wheelScale = 1
  },
  { passive: false },
)

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey
  const key = e.key
  if (mod && (key === 'f' || key === 'F')) {
    e.preventDefault()
    openFind()
    return
  }
  if (mod && (key === '=' || key === '+')) {
    e.preventDefault()
    pdfViewer.increaseScale()
    return
  }
  if (mod && key === '-') {
    e.preventDefault()
    pdfViewer.decreaseScale()
    return
  }
  if (mod && key === '0') {
    e.preventDefault()
    pdfViewer.currentScaleValue = 'page-width'
    return
  }
  if (doneDialog.open) {
    if (!mod && (key === 'c' || key === 'C')) {
      e.preventDefault()
      doneDialog.close('close')
    } else if (!mod && (key === 's' || key === 'S') && task?.canReturn) {
      e.preventDefault()
      doneDialog.close('claude')
    }
    return
  }
  if (mod || e.altKey || helpDialog.open || e.target.closest('input, select, textarea')) return
  if (!pdfDoc) return
  const canPanX = container.scrollWidth > container.clientWidth
  switch (key) {
    case 'ArrowRight':
      if (canPanX) return
    // falls through
    case 'j':
    case 'n':
      pdfViewer.nextPage()
      break
    case 'ArrowLeft':
      if (canPanX) return
    // falls through
    case 'k':
    case 'p':
      pdfViewer.previousPage()
      break
    case 'Home':
      goToPage(1)
      break
    case 'End':
      goToPage(numPages())
      break
    case 'g':
      pageInput.focus()
      pageInput.select()
      break
    case '+':
    case '=':
      pdfViewer.increaseScale()
      break
    case '-':
      pdfViewer.decreaseScale()
      break
    case '0':
      pdfViewer.currentScaleValue = 'page-width'
      break
    case '/':
      openFind()
      break
    case 'm':
      setRead(currentPage(), !readSet.has(currentPage()))
      toast(readSet.has(currentPage()) ? `Page ${currentPage()} marked read` : `Page ${currentPage()} marked unread`, 1200)
      break
    case 'u':
      el('firstUnread').click()
      break
    case 'b':
      setSidebar(el('sidebar').hidden)
      break
    case 't':
      cycleTheme()
      break
    case '?':
      helpDialog.showModal()
      break
    case 'Escape':
      if (!el('findbar').hidden) closeFind()
      return
    default:
      return
  }
  e.preventDefault()
})

// ---------------------------------------------------------------- start

// The keys take ⌘ or Ctrl anywhere; the labels say what this keyboard has.
const isMac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '')
if (!isMac) {
  for (const node of document.querySelectorAll('[title*="⌘"]')) node.title = node.title.replaceAll('⌘', 'Ctrl+')
  for (const node of document.querySelectorAll('.keys dt')) {
    node.textContent = node.textContent.replaceAll('⌘ + ', 'Ctrl + ').replaceAll('⌘', 'Ctrl+')
  }
}

applyTheme(local('theme') || 'light')
setSidebar(local('sidebar') === '1')
setTab(local('tab') || 'contents')
connect()
