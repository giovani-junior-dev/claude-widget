'use strict'

// A ilha tem tres modos, como a do iPhone:
//   pill     — compacta, alterna entre as fontes como Live Activities
//   overview — expandida no hover, uma linha por fonte
//   detail   — clique numa fonte: o painel completo dela
// A janela nunca muda de tamanho; quem cresce e o #island, por CSS.

const $ = id => document.getElementById(id)
const api = window.claudeWidget

const META = {
  claude: { accent: '#D97757' },
  codex: { accent: '#E5E5EA' },
  kimi: { accent: '#3A8BFF' },
  grok: { accent: '#E5E5EA' },
  antigravity: { accent: '#4C8DFF' },
  zcode: { accent: '#E5E5EA' },
  qwen: { accent: '#7B6CFF' }
}
const SEV = { ok: 'var(--ok)', warn: 'var(--warn)', crit: 'var(--crit)' }
const logo = id => `assets/logos/${id}.svg`

const STATUS_TEXT = {
  ok: 'atualizado',
  loading: 'lendo',
  expired: 'login expirado',
  offline: 'sem conexão',
  error: 'erro'
}

const ROTATE_MS = 6000
const HOVER_OPEN_MS = 140
const LEAVE_CLOSE_MS = 650

let last = null // ultimo estado vindo do main
let mode = 'pill'
let detailId = null
let rotateIdx = 0
let hovering = false
let openTimer = null
let closeTimer = null

// ---------------------------------------------------------------- utilidades

function el (tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

const SVGNS = 'http://www.w3.org/2000/svg'

// Anel de progresso. Criado uma vez e atualizado no lugar, para a transicao do
// dashoffset funcionar entre um segundo e outro.
function makeRing (size, stroke) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('class', 'ring')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  for (const k of ['t', 'a']) {
    const ci = document.createElementNS(SVGNS, 'circle')
    ci.setAttribute('class', k)
    ci.setAttribute('cx', size / 2)
    ci.setAttribute('cy', size / 2)
    ci.setAttribute('r', r)
    ci.setAttribute('stroke-width', stroke)
    if (k === 'a') {
      ci.setAttribute('stroke-dasharray', c)
      ci.setAttribute('stroke-dashoffset', c)
    }
    svg.appendChild(ci)
  }
  svg._c = c
  return svg
}

function setRing (svg, pct, color) {
  const a = svg.querySelector('.a')
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  // Um fio minimo mesmo em 0%: anel vazio parece quebrado, nao "zerado".
  a.setAttribute('stroke-dashoffset', svg._c * (1 - Math.max(p, 1.5) / 100))
  a.style.stroke = color
  a.style.opacity = pct == null ? 0 : 1
}

function setBar (fill, pct, color) {
  fill.style.transform = `scaleX(${Math.max(0, Math.min(100, pct || 0)) / 100})`
  fill.style.background = color
}

// Cor do medidor: acento da marca enquanto esta tranquilo; amarelo/vermelho
// tomam o lugar quando a cota aperta.
function tone (id, severity) {
  if (severity === 'crit' || severity === 'warn') return SEV[severity]
  return (META[id] && META[id].accent) || SEV.ok
}

function worst (vm) {
  const all = [vm && vm.session && vm.session.severity, ...((vm && vm.windows) || []).map(w => w.severity), vm && vm.spend && vm.spend.severity]
  if (all.includes('crit')) return 'crit'
  if (all.includes('warn')) return 'warn'
  return 'ok'
}

// O numero que resume a fonte: a sessao curta, ou a primeira janela se nao houver sessao.
function headline (p) {
  const vm = p.vm
  if (vm && vm.session) return { pct: vm.session.pct, label: vm.session.label || '5 h', when: vm.session.countdown, severity: vm.session.severity }
  if (vm && vm.windows && vm.windows[0]) {
    const w = vm.windows[0]
    return { pct: w.pct, label: w.name, when: w.when, severity: w.severity }
  }
  return { pct: null, label: '', when: null, severity: 'ok' }
}

function ago (ms) {
  if (ms == null) return ''
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `há ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  return `há ${Math.round(m / 60)} h`
}

function shown () {
  return last ? last.providers.filter(p => p.available) : []
}

function statusLine (p) {
  if (p.status === 'ok' || (p.status === 'loading' && p.vm)) {
    const h = headline(p)
    if (h.when === 'livre') return 'sem uso nas últimas 5 h'
    return h.when ? (p.vm && p.vm.session ? `reinicia em ${h.when}` : `reinicia ${h.when}`) : ''
  }
  return STATUS_TEXT[p.status] || ''
}

// ---------------------------------------------------------------- modo e tamanho

function sizeFor (m) {
  const v = $(m)
  if (m === 'pill') return { w: Math.max(200, Math.min(340, v.scrollWidth)), h: 38 }
  return { w: v.offsetWidth, h: Math.min(v.scrollHeight, window.innerHeight - 24) }
}

// Folga ate a borda da janela nos lados ancorados (a sombra precisa de espaco).
// Igual ao INSET do main.
const INSET = 24

function fit () {
  const s = sizeFor(mode)
  const island = $('island')
  const a = (last && last.anchor) || { h: 'center', v: 'top' }
  island.dataset.h = a.h
  island.dataset.v = a.v
  island.style.width = s.w + 'px'
  island.style.height = s.h + 'px'
  // Tamanho-alvo, nao o da animacao: o hover ja vale para onde a ilha vai chegar.
  const x = a.h === 'left' ? INSET : a.h === 'right' ? window.innerWidth - INSET - s.w : (window.innerWidth - s.w) / 2
  const y = a.v === 'bottom' ? window.innerHeight - INSET - s.h : 0
  api.reportRect({ x: Math.round(x), y: Math.round(y), w: s.w, h: s.h })
}

function setMode (m) {
  if (m === mode) return
  mode = m
  $('island').dataset.mode = m
  for (const v of ['pill', 'overview', 'detail']) $(v).classList.toggle('on', v === m)
  render()
}

function openDetail (id) {
  detailId = id
  api.setSource(id)
  setMode('detail')
}

// ---------------------------------------------------------------- pilula

function renderPill () {
  const list = shown()
  const box = $('pill')
  if (!list.length) return
  if (rotateIdx >= list.length) rotateIdx = 0
  const p = list[rotateIdx]
  const h = headline(p)

  // Recria so quando a fonte muda: assim a animacao de entrada roda uma vez por troca.
  let slide = box.firstElementChild
  if (!slide || slide.dataset.id !== p.id) {
    box.textContent = ''
    slide = el('div', 'slide')
    slide.dataset.id = p.id
    const img = el('img', 'logo')
    img.src = logo(p.id)
    img.alt = ''
    slide.append(img, el('span', 'who', p.label), el('span', 'what'), el('span', 'pct num'))
    const ring = makeRing(20, 3)
    slide.append(ring)
    const dots = el('span', 'dots')
    slide.append(dots)
    box.append(slide)
  }

  const ok = p.status === 'ok' || (p.status === 'loading' && p.vm)
  slide.querySelector('.what').textContent = ok ? (h.when || '') : (STATUS_TEXT[p.status] || '')
  slide.querySelector('.pct').textContent = h.pct == null ? '—' : `${h.pct}%`
  setRing(slide.querySelector('.ring'), h.pct, ok ? tone(p.id, h.severity) : SEV.warn)

  const dots = slide.querySelector('.dots')
  if (dots.children.length !== list.length) {
    dots.textContent = ''
    list.forEach(() => dots.append(el('i')))
  }
  ;[...dots.children].forEach((d, i) => d.classList.toggle('on', i === rotateIdx))
}

setInterval(() => {
  if (hovering || mode !== 'pill') return
  const list = shown()
  if (list.length < 2) return
  rotateIdx = (rotateIdx + 1) % list.length
  renderPill()
  fit()
}, ROTATE_MS)

// ---------------------------------------------------------------- visao geral

const cards = new Map()

function makeCard (p) {
  const card = el('button', 'card')
  card.type = 'button'
  card.dataset.id = p.id

  const tile = el('div', 'tile')
  const img = el('img')
  img.src = logo(p.id)
  img.alt = ''
  const st = el('span', 'st')
  tile.append(img, st)

  const mid = el('div', 'mid')
  const line1 = el('div', 'line1')
  line1.append(el('span', 'name', p.label), el('span', 'plan'), el('span', 'when'))
  const mini = el('div', 'mini')
  const bar = el('div', 'bar')
  bar.append(el('i'))
  mini.append(el('span', 'lbl'), bar, el('span', 'v num'))
  mid.append(line1, mini)

  const gauge = el('div', 'gaugebox')
  gauge.append(makeRing(44, 4.5))
  gauge.append(el('div', 'v num'))

  card.append(tile, mid, gauge)
  card.addEventListener('click', () => openDetail(p.id))
  return card
}

function renderOverview () {
  const list = shown()
  const box = $('cards')
  const ids = list.map(p => p.id)
  for (const [id, c] of cards) if (!ids.includes(id)) { c.remove(); cards.delete(id) }

  list.forEach((p, i) => {
    let c = cards.get(p.id)
    if (!c) { c = makeCard(p); cards.set(p.id, c) }
    if (box.children[i] !== c) box.insertBefore(c, box.children[i] || null)

    const ok = p.status === 'ok' || (p.status === 'loading' && p.vm)
    const h = headline(p)
    c.querySelector('.plan').textContent = p.plan || ''
    c.querySelector('.when').textContent = statusLine(p)
    const st = c.querySelector('.st')
    st.hidden = ok
    st.style.background = p.status === 'error' ? SEV.crit : SEV.warn

    // Barra fina: a janela mais longa (semana) quando o anel ja mostra a curta.
    const w = p.vm && p.vm.session ? (p.vm.windows || [])[0] : (p.vm && p.vm.windows || [])[1]
    const mini = c.querySelector('.mini')
    mini.style.visibility = w ? 'visible' : 'hidden'
    if (w) {
      mini.querySelector('.lbl').textContent = w.name
      mini.querySelector('.v').textContent = w.pct == null ? '—' : `${w.pct}%`
      setBar(mini.querySelector('i'), w.pct, tone(p.id, w.severity))
    }

    setRing(c.querySelector('.gaugebox .ring'), h.pct, tone(p.id, h.severity))
    const v = c.querySelector('.gaugebox .v')
    v.innerHTML = ''
    if (h.pct == null) v.textContent = '—'
    else { v.append(String(h.pct)); v.append(el('small', null, '%')) }
    c.title = h.label ? `${p.label} · ${h.label}` : p.label
  })

  const n = list.filter(p => p.status === 'ok').length
  $('ov-sub').textContent = `${n} de ${list.length} ${list.length === 1 ? 'fonte' : 'fontes'} em dia`
  $('ov-refresh').classList.toggle('spin', list.some(p => p.status === 'loading'))
}

// ---------------------------------------------------------------- detalhe

let heroRing = null

function rowEl (name, when, pct, color) {
  const r = el('div', 'row')
  const top = el('div', 'top')
  top.append(el('span', 'name', name), el('span', 'when', when || ''), el('span', 'val num', pct == null ? '—' : `${pct}%`))
  const bar = el('div', 'bar')
  const fill = el('i')
  bar.append(fill)
  r.append(top, bar)
  // Depois do primeiro quadro, para a barra crescer em vez de nascer cheia.
  requestAnimationFrame(() => setBar(fill, pct, color))
  return r
}

// Atualiza as linhas no lugar quando a quantidade bate; senao reconstroi.
function renderRows (box, rows, id) {
  if (box.children.length !== rows.length) {
    box.textContent = ''
    rows.forEach(w => box.append(rowEl(w.name, w.when, w.pct, tone(id, w.severity))))
    return
  }
  rows.forEach((w, i) => {
    const r = box.children[i]
    r.querySelector('.name').textContent = w.name
    r.querySelector('.when').textContent = w.when || ''
    r.querySelector('.val').textContent = w.pct == null ? '—' : `${w.pct}%`
    setBar(r.querySelector('i'), w.pct, tone(id, w.severity))
  })
}

function renderDetail () {
  const p = last.providers.find(x => x.id === detailId && x.available)
  if (!p) { setMode('overview'); return }
  const vm = p.vm
  document.body.classList.toggle('stale', !!p.stale)

  $('dt-logo').src = logo(p.id)
  $('dt-name').textContent = p.label
  $('dt-plan').textContent = p.plan || ''

  // Banner: so quando ha algo para o usuario fazer.
  const banner = $('dt-banner')
  let text = null
  if (p.status === 'expired') text = `Login expirado. ${p.hint || ''}`.trim()
  else if (p.status === 'offline') text = 'Sem conexão. Continua tentando, com intervalo cada vez maior.'
  else if (p.status === 'error') text = p.message || 'Erro ao consultar.'
  banner.classList.toggle('on', !!text)
  banner.classList.toggle('crit', p.status === 'error')
  $('dt-banner-text').textContent = text || ''

  // Mostrador
  if (!heroRing) { heroRing = makeRing(104, 9); $('dt-gauge').prepend(heroRing) }
  const s = vm && vm.session
  const h = headline(p)
  setRing(heroRing, h.pct, tone(p.id, h.severity))
  const pctBox = $('dt-pct')
  pctBox.innerHTML = ''
  if (h.pct == null) pctBox.textContent = '—'
  else { pctBox.append(String(h.pct)); pctBox.append(el('small', null, '%')) }
  $('dt-cap').textContent = h.label || ''
  $('dt-eyebrow').textContent = p.stale ? 'último valor' : (s ? 'reinicia em' : 'reinicia')
  $('dt-countdown').textContent = (s ? s.countdown : h.when) || '—'
  $('dt-at').textContent = (s && s.at) || ''

  // Linhas: sem a que ja esta no mostrador quando nao ha sessao.
  const rows = ((vm && vm.windows) || []).filter((w, i) => s || i > 0)
  renderRows($('dt-rows'), rows, p.id)

  // Creditos extras (Claude)
  const spendBox = $('dt-spend')
  const sp = vm && vm.spend
  spendBox.hidden = !sp
  if (sp) {
    spendBox.textContent = ''
    const r = el('div', 'row')
    const top = el('div', 'top')
    top.append(el('span', 'name', 'Créditos extras'))
    const money = el('span', 'money num', sp.used)
    if (sp.limit) money.append(el('span', null, ` / ${sp.limit}`))
    top.append(money)
    const bar = el('div', 'bar')
    const fill = el('i')
    bar.append(fill)
    r.append(top, bar)
    spendBox.append(r)
    setBar(fill, sp.pct, sp.severity === 'ok' ? META.claude.accent : SEV[sp.severity])
  }

  $('dt-note').textContent = vm && vm.estimate
    ? 'Estimativa: requisições contadas no histórico local do Qwen Code, em janelas móveis, contra o limite do plano escolhido no menu da bandeja.'
    : ''

  // Tokens por modelo: so o Claude grava transcript com uso por modelo.
  const isClaude = p.id === 'claude'
  $('dt-tokens-toggle').hidden = !isClaude
  $('dt-tokens-toggle').textContent = last.tokensOpen ? 'ocultar tokens' : 'tokens por modelo'
  $('dt-tokens').hidden = !(isClaude && last.tokensOpen)
  if (isClaude && last.tokensOpen) renderTokens(last.tokens, last.tokenDays, last.tokensBusy)

  const ok = p.status === 'ok'
  $('dt-dot').style.background = ok ? SEV.ok : (p.status === 'error' ? SEV.crit : SEV.warn)
  $('dt-status').textContent = p.local && ok ? 'histórico local' : (STATUS_TEXT[p.status] || '')
  $('dt-ago').textContent = ago(p.age)
}

// ---------------------------------------------------------------- tokens (Claude)

const compactNum = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })

// Nome cru da API vira algo legivel: claude-opus-4-8 -> Opus 4.8
function prettyModel (id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase() + m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`
}

function renderTokens (tokens, days, busy) {
  const list = $('tokens-list')
  const note = $('tk-note')
  $('tk-spinner').hidden = !busy
  for (const b of $('tk-range').children) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days))

  if (!tokens) { list.textContent = ''; list.append(el('div', 'empty', 'Lendo o histórico desta máquina…')); note.textContent = ''; return }
  if (!tokens.models.length) { list.textContent = ''; list.append(el('div', 'empty', `Nenhuma conversa nos últimos ${tokens.days} dias.`)); note.textContent = ''; return }

  const top = tokens.models[0].output || 1
  list.textContent = ''
  for (const m of tokens.models) {
    const r = el('div', 'row trow' + (m.isClaude ? '' : ' alien'))
    const t = el('div', 'top')
    const name = el('span', 'name', prettyModel(m.model))
    name.title = m.model
    t.append(name, el('span', 'when', `${compactNum.format(m.calls)} resp.`), el('span', 'val num', compactNum.format(m.output)))
    const bar = el('div', 'bar')
    const fill = el('i')
    bar.append(fill)
    r.append(t, bar)
    list.append(r)
    // Cor da marca = consome a cota. Cinza = passou pelo Claude Code, mas e de outro provedor.
    setBar(fill, Math.max(1.2, (m.output / top) * 100), m.isClaude ? META.claude.accent : 'var(--faint)')
  }
  const alien = tokens.models.some(m => !m.isClaude)
  note.textContent = alien
    ? 'Tokens de saída. Em cinza, modelos de outros provedores que passaram pelo Claude Code e não gastam a cota.'
    : 'Tokens de saída gerados nesta máquina, não da conta inteira.'
}

// ---------------------------------------------------------------- ciclo

function render () {
  if (!last) return
  const list = shown()
  $('island').classList.toggle('alarm', list.some(p => p.status === 'ok' && worst(p.vm) === 'crit'))
  if (mode === 'pill') renderPill()
  if (mode === 'overview') renderOverview()
  if (mode === 'detail') renderDetail()
  fit()
}

api.onState(state => {
  last = state
  if (detailId == null) detailId = state.source
  render()
})

// ---------------------------------------------------------------- interacao


// O main acompanha o cursor e avisa quando ele entra ou sai da ilha (no
// Windows a janela atravessavel nao recebe mousemove).
api.onHover(inside => {
  hovering = inside
  if (!inside) dragLock = false
  if (inside && dragLock) return
  if (inside) {
    clearTimeout(closeTimer)
    if (mode === 'pill') openTimer = setTimeout(() => setMode('overview'), HOVER_OPEN_MS)
  } else {
    clearTimeout(openTimer)
    closeTimer = setTimeout(() => setMode('pill'), LEAVE_CLOSE_MS)
  }
})

// ---------------------------------------------------------------- arrastar

// Segurar e puxar (fora de botoes) leva a ilha para outro lugar da tela. Ela
// encolhe para pilula, segue o cursor, e o main decide a ancoragem ao soltar.
const DRAG_START_PX = 5
let press = null
let dragging = false
let dragLock = false // depois de soltar, nao reabre so porque o mouse ficou em cima
let swallowClick = false

$('island').addEventListener('mousedown', e => {
  if (e.button !== 0 || e.target.closest('button:not(.card), .seg, #tokens-list')) return
  press = { x: e.screenX, y: e.screenY }
})

document.addEventListener('mousemove', e => {
  if (!press || dragging) return
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < DRAG_START_PX) return
  dragging = true
  dragLock = true
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  document.body.style.cursor = 'grabbing'
  setMode('pill')
  api.dragStart()
})

function drop () {
  press = null
  if (!dragging) return
  dragging = false
  swallowClick = true
  document.body.style.cursor = ''
  api.dragEnd()
}
document.addEventListener('mouseup', drop)
window.addEventListener('blur', drop)

// O clique que encerra um arrasto nao pode abrir card nem pilula.
document.addEventListener('click', e => {
  if (!swallowClick) return
  swallowClick = false
  e.stopPropagation()
  e.preventDefault()
}, true)

$('pill').addEventListener('click', () => { clearTimeout(openTimer); setMode('overview') })
$('pill').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') setMode('overview') })
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMode(mode === 'detail' ? 'overview' : 'pill') })

$('ov-refresh').addEventListener('click', () => api.refresh())
$('ov-hide').addEventListener('click', () => { setMode('pill'); api.hide() })
$('dt-back').addEventListener('click', () => setMode('overview'))
$('dt-refresh').addEventListener('click', () => api.refresh(detailId))
$('dt-tokens-toggle').addEventListener('click', () => api.toggleTokens())
$('tk-range').addEventListener('click', e => {
  const b = e.target.closest('button')
  if (b) api.setTokenDays(Number(b.dataset.days))
})

// Conteudo que muda de altura sozinho (lista de tokens carregando) reajusta a ilha.
new ResizeObserver(() => fit()).observe($('detail'))
new ResizeObserver(() => fit()).observe($('overview'))
