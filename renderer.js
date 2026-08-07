'use strict'

const $ = id => document.getElementById(id)
const ARC_LENGTH = 132 // semicirculo r=42: pi * 42

const COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', crit: 'var(--crit)' }

const STATUS = {
  ok: { dot: 'ok', text: 'oauth' },
  expired: { dot: 'warn', text: 'token expirado' },
  offline: { dot: 'warn', text: 'sem conexão' },
  error: { dot: 'crit', text: 'erro' },
  loading: { dot: 'ok', text: 'lendo' }
}

const BANNER = {
  expired: 'Credencial expirou. Abra o Claude Code uma vez para renovar; o widget volta sozinho.',
  offline: 'Sem conexão com a API. Continua tentando, com intervalo cada vez maior.',
  error: null // usa a mensagem que vier do processo principal
}

function setRow (row, data) {
  row.querySelector('.name').textContent = data.name
  row.querySelector('.when').textContent = data.when || ''
  row.querySelector('.val').textContent = data.pct == null ? '—' : data.pct + '%'
  const fill = row.querySelector('i')
  fill.style.transform = `scaleX(${(data.pct || 0) / 100})`
  fill.style.background = COLOR[data.severity] || COLOR.ok
}

function makeRow () {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    '<div class="top"><span class="name"></span><span class="when"></span><span class="val"></span></div>' +
    '<div class="bar"><i></i></div>'
  return row
}

// Reaproveita as linhas existentes: o numero de janelas semanais muda conforme
// a API passa a preencher outros modelos.
function renderRows (windows) {
  const box = $('rows')
  while (box.children.length > windows.length) box.lastChild.remove()
  while (box.children.length < windows.length) box.appendChild(makeRow())
  windows.forEach((w, i) => setRow(box.children[i], w))
}

function renderSession (session) {
  const arc = $('arc')
  if (!session) {
    $('session-pct').textContent = '—'
    $('countdown').textContent = '—'
    $('reset-at').textContent = ''
    arc.style.strokeDashoffset = ARC_LENGTH
    return
  }
  $('session-pct').innerHTML = session.pct + '<sub>%</sub>'
  $('countdown').textContent = session.countdown || '—'
  $('reset-at').textContent = session.at || ''
  arc.style.strokeDashoffset = ARC_LENGTH * (1 - session.pct / 100)
  arc.style.stroke = COLOR[session.severity] || COLOR.ok
}

function renderSpend (spend) {
  const box = $('spend')
  if (!spend) { box.classList.add('off'); return }
  box.classList.remove('off')
  $('spend-money').innerHTML = spend.limit
    ? `${spend.used} <span>/ ${spend.limit}</span>`
    : spend.used
  const fill = $('spend-bar')
  fill.style.transform = `scaleX(${(spend.pct || 0) / 100})`
  // Credito e dinheiro, nao cota de uso: cor propria, para nao se confundir com
  // os medidores. So cede a vez quando a API sinaliza atencao ou risco.
  fill.style.background = spend.severity === 'ok' ? 'var(--copper)' : COLOR[spend.severity]
}

function renderBanner (status, message) {
  const box = $('banner')
  const text = status === 'error' ? message : BANNER[status]
  if (!text) { box.classList.remove('on'); return }
  box.classList.add('on')
  $('banner-text').textContent = text
  $('banner-dot').style.background = status === 'error' ? COLOR.crit : COLOR.warn
}

const compactNum = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })

// Nome cru da API vira algo legivel: claude-opus-4-8 -> Opus 4.8
function prettyModel (id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  const family = m[1][0].toUpperCase() + m[1].slice(1)
  return `${family} ${m[2]}${m[3] ? '.' + m[3] : ''}`
}

function makeTokenRow () {
  const row = document.createElement('div')
  row.className = 'trow'
  row.innerHTML =
    '<div class="top"><span class="tname"></span><span class="tcalls"></span><span class="tval"></span></div>' +
    '<div class="bar"><i></i></div>'
  return row
}

function renderTokens (tokens, days, busy) {
  const list = $('tokens-list')
  const note = $('tokens-note')

  $('tokens-spinner').hidden = !busy
  for (const b of $('tokens-range').children) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days))
  }

  if (!tokens) {
    list.innerHTML = '<div class="tokens-empty">Lendo o histórico desta máquina…</div>'
    note.textContent = ''
    return
  }
  if (!tokens.models.length) {
    list.innerHTML = `<div class="tokens-empty">Nenhuma conversa nos últimos ${tokens.days} dias.</div>`
    note.textContent = ''
    return
  }

  const rows = [...list.querySelectorAll('.trow')]
  while (rows.length > tokens.models.length) rows.pop().remove()
  list.querySelectorAll('.tokens-empty').forEach(e => e.remove())
  while (list.querySelectorAll('.trow').length < tokens.models.length) list.appendChild(makeTokenRow())

  const top = tokens.models[0].output || 1
  const nodes = list.querySelectorAll('.trow')
  tokens.models.forEach((m, i) => {
    const row = nodes[i]
    row.classList.toggle('alien', !m.isClaude)
    row.querySelector('.tname').textContent = prettyModel(m.model)
    row.querySelector('.tname').title = m.model
    row.querySelector('.tcalls').textContent = `${compactNum.format(m.calls)} resp.`
    row.querySelector('.tval').textContent = compactNum.format(m.output)
    const fill = row.querySelector('i')
    fill.style.transform = `scaleX(${Math.max(0.012, m.output / top)})`
    // Verde = consome a cota da conta. Cinza = passou pelo Claude Code, mas nao conta.
    fill.style.background = m.isClaude ? 'var(--ok)' : 'var(--faint)'
  })

  const rolavel = list.scrollHeight - list.clientHeight > 4
  list.classList.toggle('more', rolavel && list.scrollTop + list.clientHeight < list.scrollHeight - 4)

  const alien = tokens.models.filter(m => !m.isClaude).length
  note.textContent = alien
    ? 'Tokens de saída. As linhas em cinza são modelos de outros provedores: passaram pelo Claude Code, mas não consomem a cota da conta.'
    : 'Tokens de saída gerados nesta máquina. Não é o consumo da conta inteira.'
}

$('tokens-list').addEventListener('scroll', e => {
  const l = e.currentTarget
  l.classList.toggle('more', l.scrollTop + l.clientHeight < l.scrollHeight - 4)
})

$('tokens-range').addEventListener('click', e => {
  const b = e.target.closest('button')
  if (b) window.claudeWidget.setTokenDays(Number(b.dataset.days))
})

function ago (ms) {
  if (ms == null) return ''
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `há ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  return `há ${Math.round(m / 60)} h`
}

function renderSourceTabs (source, codexAvailable) {
  const codexBtn = $('source-tabs').querySelector('[data-source="codex"]')
  codexBtn.hidden = !codexAvailable
  for (const b of $('source-tabs').children) {
    b.setAttribute('aria-pressed', String(b.dataset.source === source))
  }
}

function render (state) {
  document.documentElement.dataset.theme = state.theme
  document.body.classList.toggle('compact', !!state.compact)
  document.body.classList.toggle('stale', !!state.stale)
  $('pin').setAttribute('aria-pressed', String(!!state.pinned))
  $('plan').textContent = state.plan || '—'
  renderSourceTabs(state.source, state.codexAvailable)
  // No compacto os tabs somem (nao cabem); o nome da fonte migra pra aqui do lado do plano.
  $('who-source').textContent = (state.source === 'codex' ? 'codex' : 'claude') + ' · '

  // A aba de tokens le o disco do Claude Code: nao existe equivalente pro Codex ainda.
  const claudeSource = state.source !== 'codex'
  $('chev').hidden = !claudeSource

  const vm = state.vm
  renderSession(vm && vm.session)
  renderRows((vm && vm.windows) || [])
  renderSpend(vm && vm.spend)
  renderBanner(state.status, state.message)

  $('meta-label').textContent = state.stale ? 'último valor' : 'reinicia em'

  // No compacto o gauge ja mostra a sessao; aqui so cabe a semana.
  $('compact-line').textContent = vm && vm.windows[0] ? `semana ${vm.windows[0].pct}%` : ''

  const s = STATUS[state.status] || STATUS.ok
  $('status-dot').style.background = COLOR[s.dot]
  $('status-text').textContent = s.text
  $('ago').textContent = ago(state.age)

  const tokensOpen = claudeSource && !!state.tokensOpen
  $('tokens').classList.toggle('on', tokensOpen && !state.compact)
  $('foot').setAttribute('aria-expanded', String(tokensOpen))
  if (tokensOpen && !state.compact) renderTokens(state.tokens, state.tokenDays, state.tokensBusy)

  window.claudeWidget.reportHeight(document.querySelector('.widget').offsetHeight)
}

window.claudeWidget.onState(render)

$('refresh').addEventListener('click', () => window.claudeWidget.refresh())
$('hide').addEventListener('click', () => window.claudeWidget.hide())
$('compact').addEventListener('click', () => window.claudeWidget.toggleCompact())
$('pin').addEventListener('click', () => window.claudeWidget.togglePin())
$('foot').addEventListener('click', () => { if (!$('chev').hidden) window.claudeWidget.toggleTokens() })
$('source-tabs').addEventListener('click', e => {
  const b = e.target.closest('button')
  if (b && !b.hidden) window.claudeWidget.setSource(b.dataset.source)
})
