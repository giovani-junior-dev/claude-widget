'use strict'

const path = require('node:path')
const fs = require('node:fs')
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  nativeTheme, powerMonitor, shell, nativeImage
} = require('electron')

const { readCreds, CredsError } = require('./lib/creds')
const { fetchUsage, UsageError } = require('./lib/usage')
const { toViewModel, worstSeverity } = require('./lib/view-model')
const codexCreds = require('./lib/codex-creds')
const { fetchCodexUsage } = require('./lib/codex-usage')
const { toCodexViewModel } = require('./lib/codex-view-model')
const kimiCreds = require('./lib/kimi-creds')
const kimiOauth = require('./lib/kimi-oauth')
const { fetchKimiUsage } = require('./lib/kimi-usage')
const { toKimiViewModel } = require('./lib/kimi-view-model')
const grokCreds = require('./lib/grok-creds')
const { fetchGrokUsage } = require('./lib/grok-usage')
const { toGrokViewModel } = require('./lib/grok-view-model')
const windowState = require('./lib/window-state')
const autostart = require('./lib/autostart')
const tokenUsage = require('./lib/token-usage')
const { nextBackoff, BASE_MS: POLL_BASE_MS } = require('./lib/poll-policy')

// A aba de tokens le arquivos do disco, nao a API: ritmo proprio, e so quando aberta.
const TOKENS_REFRESH_MS = 60_000

const WIDTH = 352 // 348 + espaco pras abas de fonte (claude/codex/kimi) na titlebar
const WIDTH_COMPACT = 230

// Aparencia fixa nos tons creme do mockup. Para voltar a acompanhar o Windows,
// troque por: () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
const theme = () => 'light'

let win = null
let tray = null
let state = null
let pollTimer = null
let tickTimer = null
let appliedHeight = 0
let quitting = false

const runtime = {
  raw: null,        // ultima resposta crua boa
  vm: null,         // modelo derivado
  at: null,         // quando a resposta chegou
  status: 'loading',
  message: null,
  stale: false,
  plan: null,
  backoff: POLL_BASE_MS,
  tokens: null,      // agregado por modelo da janela de 7 dias
  tokensAt: 0,
  tokensBusy: false
}

const codexRuntime = {
  raw: null,
  vm: null,
  at: null,
  status: 'loading',
  message: null,
  stale: false,
  plan: null,
  backoff: POLL_BASE_MS,
  available: true // vira false so quando o Codex CLI nunca rodou nesta maquina
}
let codexPollTimer = null

const kimiRuntime = {
  raw: null,
  vm: null,
  at: null,
  status: 'loading',
  message: null,
  stale: false,
  plan: null,
  backoff: POLL_BASE_MS,
  available: true, // vira false so quando o Kimi Code CLI nunca logou nesta maquina
  refreshing: false // trava reentrancia: 7 caminhos chamam refreshKimi, e cada refresh de token rotaciona o par no disco
}
let kimiPollTimer = null

const grokRuntime = {
  raw: null,
  vm: null,
  at: null,
  status: 'loading',
  message: null,
  stale: false,
  plan: null,
  backoff: POLL_BASE_MS,
  available: true // vira false so quando o Grok Build nunca logou nesta maquina
}
let grokPollTimer = null

function activeRuntime () {
  if (state.source === 'codex') return codexRuntime
  if (state.source === 'kimi') return kimiRuntime
  if (state.source === 'grok') return grokRuntime
  return runtime
}

// ---------------------------------------------------------------- cache

function cacheFile (name) {
  return path.join(app.getPath('userData'), name)
}

function saveCache () {
  if (!runtime.vm) return
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(cacheFile('last-usage.json'), JSON.stringify({ vm: runtime.vm, at: runtime.at, plan: runtime.plan }))
  } catch { /* cache e conveniencia, nao requisito */ }
}

// Abrir ja com numero, mesmo antes da primeira resposta. Sempre marcado como velho.
function loadCache () {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile('last-usage.json'), 'utf8'))
    if (c && c.vm) {
      runtime.vm = c.vm
      runtime.at = c.at
      runtime.plan = c.plan
      runtime.stale = true
    }
  } catch { /* primeira execucao */ }
}

function saveCodexCache () {
  if (!codexRuntime.vm) return
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(cacheFile('last-codex-usage.json'), JSON.stringify({ vm: codexRuntime.vm, at: codexRuntime.at, plan: codexRuntime.plan }))
  } catch { /* cache e conveniencia, nao requisito */ }
}

function loadCodexCache () {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile('last-codex-usage.json'), 'utf8'))
    if (c && c.vm) {
      codexRuntime.vm = c.vm
      codexRuntime.at = c.at
      codexRuntime.plan = c.plan
      codexRuntime.stale = true
    }
  } catch { /* primeira execucao */ }
}

function saveKimiCache () {
  if (!kimiRuntime.vm) return
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(cacheFile('last-kimi-usage.json'), JSON.stringify({ vm: kimiRuntime.vm, at: kimiRuntime.at, plan: kimiRuntime.plan }))
  } catch { /* cache e conveniencia, nao requisito */ }
}

function loadKimiCache () {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile('last-kimi-usage.json'), 'utf8'))
    if (c && c.vm) {
      kimiRuntime.vm = c.vm
      kimiRuntime.at = c.at
      kimiRuntime.plan = c.plan
      kimiRuntime.stale = true
    }
  } catch { /* primeira execucao */ }
}

function saveGrokCache () {
  if (!grokRuntime.vm) return
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(cacheFile('last-grok-usage.json'), JSON.stringify({ vm: grokRuntime.vm, at: grokRuntime.at }))
  } catch { /* cache e conveniencia, nao requisito */ }
}

function loadGrokCache () {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile('last-grok-usage.json'), 'utf8'))
    if (c && c.vm) {
      grokRuntime.vm = c.vm
      grokRuntime.at = c.at
      grokRuntime.stale = true
    }
  } catch { /* primeira execucao */ }
}

// ---------------------------------------------------------------- ciclo

async function refresh () {
  let creds
  try {
    creds = readCreds()
  } catch (err) {
    return fail(err instanceof CredsError && err.code === 'NO_FILE' ? 'expired' : 'error', err.message)
  }

  runtime.plan = creds.plan

  // Vencido: nem vale gastar a requisicao, a resposta ja seria 401.
  if (creds.expired) {
    return fail('expired', null)
  }

  try {
    const raw = await fetchUsage(creds.token)
    runtime.raw = raw
    runtime.at = Date.now()
    runtime.vm = toViewModel(raw, runtime.at)
    runtime.status = 'ok'
    runtime.message = null
    runtime.stale = false
    runtime.backoff = nextBackoff(runtime.backoff, true)
    saveCache()
  } catch (err) {
    const code = err instanceof UsageError ? err.code : 'HTTP_ERROR'
    if (code === 'TOKEN_EXPIRED') return fail('expired', null)
    if (code === 'OFFLINE' || code === 'TIMEOUT') return fail('offline', null)
    return fail('error', err.message)
  }

  push()
  schedule()
}

function fail (status, message) {
  runtime.status = status
  runtime.message = message
  runtime.stale = true
  runtime.backoff = nextBackoff(runtime.backoff, false)
  push()
  schedule()
}

function schedule () {
  clearTimeout(pollTimer)
  // Janela escondida com icone estatico: nada muda na tela, nao ha o que buscar.
  if (win && !win.isVisible() && runtime.status === 'ok') return
  pollTimer = setTimeout(refresh, runtime.backoff)
}

// ---------------------------------------------------------------- codex

async function refreshCodex () {
  let creds
  try {
    creds = codexCreds.readCreds()
  } catch (err) {
    if (err.code === 'NO_FILE') {
      // Codex CLI nunca logou nesta maquina: nada pra mostrar, para de bater no disco.
      codexRuntime.available = false
      // A aba sumiu: se era ela que estava na tela, volta pra Claude, senao a
      // janela abre presa numa fonte escondida, travada em "lendo".
      if (state.source === 'codex') {
        state = { ...state, source: 'claude' }
        windowState.save(app, state)
      }
      push()
      return
    }
    return failCodex('error', err.message)
  }

  if (creds.expired) return failCodex('expired', null)
  if (codexRuntime.plan == null) codexRuntime.plan = creds.plan

  try {
    const raw = await fetchCodexUsage(creds.token)
    codexRuntime.raw = raw
    codexRuntime.at = Date.now()
    codexRuntime.vm = toCodexViewModel(raw, codexRuntime.at)
    if (typeof raw.plan_type === 'string') codexRuntime.plan = raw.plan_type
    codexRuntime.status = 'ok'
    codexRuntime.message = null
    codexRuntime.stale = false
    codexRuntime.backoff = nextBackoff(codexRuntime.backoff, true)
    saveCodexCache()
  } catch (err) {
    const code = err instanceof UsageError ? err.code : 'HTTP_ERROR'
    if (code === 'TOKEN_EXPIRED') return failCodex('expired', null)
    if (code === 'OFFLINE' || code === 'TIMEOUT') return failCodex('offline', null)
    return failCodex('error', err.message)
  }

  push()
  scheduleCodex()
}

function failCodex (status, message) {
  codexRuntime.status = status
  codexRuntime.message = message
  codexRuntime.stale = true
  codexRuntime.backoff = nextBackoff(codexRuntime.backoff, false)
  push()
  scheduleCodex()
}

function scheduleCodex () {
  clearTimeout(codexPollTimer)
  if (!codexRuntime.available) return
  if (win && !win.isVisible() && codexRuntime.status === 'ok') return
  codexPollTimer = setTimeout(refreshCodex, codexRuntime.backoff)
}

// ---------------------------------------------------------------- kimi

async function refreshKimi () {
  if (kimiRuntime.refreshing) return
  kimiRuntime.refreshing = true
  try {
    await refreshKimiInner()
  } finally {
    kimiRuntime.refreshing = false
  }
}

async function refreshKimiInner () {
  let creds
  try {
    creds = kimiCreds.readCreds()
  } catch (err) {
    if (err.code === 'NO_FILE') {
      // Kimi Code CLI nunca logou nesta maquina: nada pra mostrar, para de bater no disco.
      kimiRuntime.available = false
      if (state.source === 'kimi') {
        state = { ...state, source: 'claude' }
        windowState.save(app, state)
      }
      push()
      return
    }
    return failKimi('error', err.message)
  }

  // Token dura so 15 min: quase toda leitura passa por aqui. Regrava o par
  // novo no arquivo do CLI real, senao o login dele quebra na proxima vez.
  let accessToken = creds.accessToken
  if (creds.expired) {
    try {
      const refreshed = await kimiOauth.refreshAccessToken(creds.refreshToken)
      kimiCreds.writeCreds(refreshed)
      accessToken = refreshed.access_token
    } catch (err) {
      const code = err instanceof kimiOauth.KimiOAuthError ? err.code : 'HTTP_ERROR'
      if (code === 'TOKEN_EXPIRED') return failKimi('expired', null)
      if (code === 'OFFLINE' || code === 'TIMEOUT') return failKimi('offline', null)
      return failKimi('error', err.message)
    }
  }

  try {
    const raw = await fetchKimiUsage(accessToken)
    kimiRuntime.raw = raw
    kimiRuntime.at = Date.now()
    kimiRuntime.vm = toKimiViewModel(raw, kimiRuntime.at)
    kimiRuntime.status = 'ok'
    kimiRuntime.message = null
    kimiRuntime.stale = false
    kimiRuntime.backoff = nextBackoff(kimiRuntime.backoff, true)
    saveKimiCache()
  } catch (err) {
    const code = err instanceof UsageError ? err.code : 'HTTP_ERROR'
    if (code === 'TOKEN_EXPIRED') return failKimi('expired', null)
    if (code === 'OFFLINE' || code === 'TIMEOUT') return failKimi('offline', null)
    return failKimi('error', err.message)
  }

  push()
  scheduleKimi()
}

function failKimi (status, message) {
  kimiRuntime.status = status
  kimiRuntime.message = message
  kimiRuntime.stale = true
  kimiRuntime.backoff = nextBackoff(kimiRuntime.backoff, false)
  push()
  scheduleKimi()
}

function scheduleKimi () {
  clearTimeout(kimiPollTimer)
  if (!kimiRuntime.available) return
  if (win && !win.isVisible() && kimiRuntime.status === 'ok') return
  kimiPollTimer = setTimeout(refreshKimi, kimiRuntime.backoff)
}

// ---------------------------------------------------------------- grok

async function refreshGrok () {
  let creds
  try {
    creds = grokCreds.readCreds()
  } catch (err) {
    if (err.code === 'NO_FILE') {
      // Grok Build nunca logou nesta maquina: nada pra mostrar, para de bater no disco.
      grokRuntime.available = false
      if (state.source === 'grok') {
        state = { ...state, source: 'claude' }
        windowState.save(app, state)
      }
      push()
      return
    }
    return failGrok('error', err.message)
  }

  // So leitura: o Grok Build renova o proprio token sozinho na proxima vez que
  // rodar. Igual ao Codex, nunca regravamos nada no auth.json de outra ferramenta.
  if (creds.expired) return failGrok('expired', null)

  try {
    const raw = await fetchGrokUsage(creds.token, creds.userId)
    grokRuntime.raw = raw
    grokRuntime.at = Date.now()
    grokRuntime.vm = toGrokViewModel(raw, grokRuntime.at)
    grokRuntime.status = 'ok'
    grokRuntime.message = null
    grokRuntime.stale = false
    grokRuntime.backoff = nextBackoff(grokRuntime.backoff, true)
    saveGrokCache()
  } catch (err) {
    const code = err instanceof UsageError ? err.code : 'HTTP_ERROR'
    if (code === 'TOKEN_EXPIRED') return failGrok('expired', null)
    if (code === 'OFFLINE' || code === 'TIMEOUT') return failGrok('offline', null)
    return failGrok('error', err.message)
  }

  push()
  scheduleGrok()
}

function failGrok (status, message) {
  grokRuntime.status = status
  grokRuntime.message = message
  grokRuntime.stale = true
  grokRuntime.backoff = nextBackoff(grokRuntime.backoff, false)
  push()
  scheduleGrok()
}

function scheduleGrok () {
  clearTimeout(grokPollTimer)
  if (!grokRuntime.available) return
  if (win && !win.isVisible() && grokRuntime.status === 'ok') return
  grokPollTimer = setTimeout(refreshGrok, grokRuntime.backoff)
}

function push () {
  if (win && !win.isDestroyed()) {
    const r = activeRuntime()
    win.webContents.send('state', {
      source: state.source,
      codexAvailable: codexRuntime.available,
      kimiAvailable: kimiRuntime.available,
      grokAvailable: grokRuntime.available,
      vm: r.vm,
      status: r.status,
      message: r.message,
      stale: r.stale,
      plan: r.plan,
      age: r.at ? Date.now() - r.at : null,
      compact: state.compact,
      pinned: state.pinned,
      tokensOpen: state.tokensOpen,
      tokens: runtime.tokens, // aba de tokens e so do Claude
      tokenDays: state.tokenDays,
      tokensBusy: runtime.tokensBusy,
      theme: theme()
    })
  }
  updateTray()
}

// Uma fonte de verdade para a contagem regressiva: o modelo e rederivado do
// bruto a cada segundo, em vez de o renderer manter um relogio proprio.
function tick () {
  if (!win || !win.isVisible()) return
  if (runtime.status === 'ok' && runtime.raw) {
    runtime.vm = toViewModel(runtime.raw, Date.now())
  }
  if (codexRuntime.status === 'ok' && codexRuntime.raw) {
    codexRuntime.vm = toCodexViewModel(codexRuntime.raw, Date.now())
  }
  if (kimiRuntime.status === 'ok' && kimiRuntime.raw) {
    kimiRuntime.vm = toKimiViewModel(kimiRuntime.raw, Date.now())
  }
  if (grokRuntime.status === 'ok' && grokRuntime.raw) {
    grokRuntime.vm = toGrokViewModel(grokRuntime.raw, Date.now())
  }
  if (state.tokensOpen && !state.compact && state.source === 'claude') refreshTokens()
  push()
}

// ---------------------------------------------------------------- tokens

function tokenIndexFile () {
  return path.join(app.getPath('userData'), 'token-index.json')
}

// Roda so com a aba aberta. A leitura e assincrona por linha, entao a janela
// continua respondendo mesmo na primeira varredura, que e a cara.
async function refreshTokens (force = false) {
  if (runtime.tokensBusy) return
  if (!force && Date.now() - runtime.tokensAt < TOKENS_REFRESH_MS) return
  runtime.tokensBusy = true
  push() // acende o indicador: a primeira varredura de 90 dias demora alguns segundos
  try {
    runtime.tokens = await tokenUsage.collect(tokenIndexFile(), Date.now(), state.tokenDays)
    runtime.tokensAt = Date.now()
  } catch (err) {
    console.error('tokens:', err.message)
    runtime.tokens = { days: state.tokenDays, models: [], totalOutput: 0, at: Date.now() }
  } finally {
    runtime.tokensBusy = false
    push()
  }
}

// ---------------------------------------------------------------- bandeja

function trayIcon (severity) {
  const file = path.join(__dirname, 'assets', `tray-${severity}.png`)
  const img = nativeImage.createFromPath(file)
  return img.isEmpty() ? nativeImage.createEmpty() : img
}

const SOURCE_LABEL = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', grok: 'Grok' }

function trayTooltip () {
  const r = activeRuntime()
  const label = SOURCE_LABEL[state.source] || SOURCE_LABEL.claude
  if (!r.vm || (!r.vm.session && !r.vm.windows.length)) return `Consumo ${label}`
  const parts = [label]
  if (r.vm.session) parts.push(`Sessão ${r.vm.session.pct}%`)
  if (r.vm.windows[0]) parts.push(`Semana ${r.vm.windows[0].pct}%`)
  if (r.stale) parts.push('(valor antigo)')
  return parts.join(' · ')
}

// Pior severidade entre as fontes disponiveis, nao so a que esta na tela: o
// icone da bandeja precisa avisar mesmo com a outra aba fechada. Uma fonte
// disponivel mas com erro (token expirado, offline) tambem conta como aviso,
// senao o icone volta pra verde escondendo o problema.
function combinedSeverity () {
  const sevs = []
  if (runtime.status === 'ok' && runtime.vm) sevs.push(worstSeverity(runtime.vm))
  else sevs.push('warn')
  if (codexRuntime.available) {
    if (codexRuntime.status === 'ok' && codexRuntime.vm) sevs.push(worstSeverity(codexRuntime.vm))
    else sevs.push('warn')
  }
  if (kimiRuntime.available) {
    if (kimiRuntime.status === 'ok' && kimiRuntime.vm) sevs.push(worstSeverity(kimiRuntime.vm))
    else sevs.push('warn')
  }
  if (grokRuntime.available) {
    if (grokRuntime.status === 'ok' && grokRuntime.vm) sevs.push(worstSeverity(grokRuntime.vm))
    else sevs.push('warn')
  }
  if (sevs.includes('crit')) return 'crit'
  if (sevs.includes('warn')) return 'warn'
  return 'ok'
}

function updateTray () {
  if (!tray) return
  tray.setImage(trayIcon(combinedSeverity()))
  tray.setToolTip(trayTooltip())
  tray.setContextMenu(buildMenu())
}

function setAutostart (on) {
  try {
    // __dirname, nao app.getAppPath(): este e sempre a pasta do main, independente
    // de como o Electron foi invocado.
    autostart.set(shell, on, process.execPath, __dirname)
  } catch (err) {
    console.error('autostart:', err.message)
  }
  updateTray()
}

function buildMenu () {
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Ocultar' : 'Mostrar', click: toggleWindow },
    {
      label: 'Atualizar agora',
      click: () => {
        runtime.backoff = POLL_BASE_MS; refresh()
        if (codexRuntime.available) { codexRuntime.backoff = POLL_BASE_MS; refreshCodex() }
        if (kimiRuntime.available) { kimiRuntime.backoff = POLL_BASE_MS; refreshKimi() }
        if (grokRuntime.available) { grokRuntime.backoff = POLL_BASE_MS; refreshGrok() }
      }
    },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: autostart.isOn(),
      click: item => setAutostart(item.checked)
    },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit() } }
  ])
}

// ---------------------------------------------------------------- janela

function toggleWindow () {
  if (!win) return
  if (win.isVisible()) {
    win.hide()
  } else {
    win.show()
    if (runtime.status !== 'ok' || Date.now() - (runtime.at || 0) > POLL_BASE_MS) refresh()
    else schedule()
    if (codexRuntime.available) {
      if (codexRuntime.status !== 'ok' || Date.now() - (codexRuntime.at || 0) > POLL_BASE_MS) refreshCodex()
      else scheduleCodex()
    }
    if (kimiRuntime.available) {
      if (kimiRuntime.status !== 'ok' || Date.now() - (kimiRuntime.at || 0) > POLL_BASE_MS) refreshKimi()
      else scheduleKimi()
    }
    if (grokRuntime.available) {
      if (grokRuntime.status !== 'ok' || Date.now() - (grokRuntime.at || 0) > POLL_BASE_MS) refreshGrok()
      else scheduleGrok()
    }
  }
  updateTray()
}

function applyWidth () {
  const w = state.compact ? WIDTH_COMPACT : WIDTH
  win.setContentSize(w, appliedHeight || 430)
}

function createWindow () {
  const width = state.compact ? WIDTH_COMPACT : WIDTH
  const pos = windowState.placement(screen, state, width, 430)

  win = new BrowserWindow({
    width,
    height: 430,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: state.pinned,
    skipTaskbar: true,
    show: false,
    backgroundColor: theme() === 'dark' ? '#1B1815' : '#FAF6EF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.loadFile('index.html')
  win.once('ready-to-show', () => { win.show(); push() })

  // 'moved' nao dispara quando o arrasto vem do app-region: o Chromium move a
  // janela por fora do caminho normal. 'move' dispara sempre; o debounce evita
  // gravar a cada pixel.
  let moveTimer = null
  const rememberPosition = () => {
    clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return
      const [x, y] = win.getPosition()
      state = { ...state, x, y }
      windowState.save(app, state)
    }, 500)
  }
  win.on('move', rememberPosition)
  win.on('moved', rememberPosition)

  win.on('close', e => {
    if (quitting) return
    e.preventDefault()
    win.hide()
    updateTray()
  })
}

// ---------------------------------------------------------------- ipc

const SOURCE_RUNTIME = { claude: () => runtime, codex: () => codexRuntime, kimi: () => kimiRuntime, grok: () => grokRuntime }
const SOURCE_REFRESH = { claude: () => refresh(), codex: () => refreshCodex(), kimi: () => refreshKimi(), grok: () => refreshGrok() }

ipcMain.on('refresh', () => {
  const r = SOURCE_RUNTIME[state.source]()
  r.backoff = POLL_BASE_MS
  SOURCE_REFRESH[state.source]()
})
ipcMain.on('hide', () => { if (win) { win.hide(); updateTray() } })

ipcMain.on('set-source', (_e, source) => {
  if (!SOURCE_RUNTIME[source]) return
  if (source !== 'claude' && !SOURCE_RUNTIME[source]().available) return
  if (source === state.source) return
  state = { ...state, source }
  windowState.save(app, state)
  push()
  // Troca pra aba que ainda nao tem dado nenhum: busca na hora, sem esperar o ciclo.
  if (SOURCE_RUNTIME[source]().at == null) SOURCE_REFRESH[source]()
})

ipcMain.on('toggle-pin', () => {
  state = { ...state, pinned: !state.pinned }
  win.setAlwaysOnTop(state.pinned)
  windowState.save(app, state)
  push()
})

ipcMain.on('toggle-compact', () => {
  state = { ...state, compact: !state.compact }
  windowState.save(app, state)
  applyWidth()
  push()
})

ipcMain.on('toggle-tokens', () => {
  state = { ...state, tokensOpen: !state.tokensOpen }
  windowState.save(app, state)
  push()
  if (state.tokensOpen) refreshTokens()
})

ipcMain.on('set-token-days', (_e, days) => {
  if (!tokenUsage.WINDOW_CHOICES.includes(days) || days === state.tokenDays) return
  state = { ...state, tokenDays: days }
  windowState.save(app, state)
  push()
  refreshTokens(true) // periodo novo: recalcula na hora, sem esperar o minuto
})

// A altura depende de quantas janelas semanais a API devolveu, entao quem manda e a tela.
ipcMain.on('height', (_e, height) => {
  if (!win || win.isDestroyed() || !height) return
  // Nunca mais alta que a area util do monitor onde a janela esta: com a aba de
  // tokens aberta em 90 dias a lista e longa, e a janela nao pode sair da tela.
  const area = screen.getDisplayMatching(win.getBounds()).workArea
  const h = Math.min(Math.round(height), area.height - 40)
  if (h === appliedHeight) return
  appliedHeight = h
  win.setContentSize(state.compact ? WIDTH_COMPACT : WIDTH, h)
})

// ---------------------------------------------------------------- vida

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus() } })

  app.whenReady().then(() => {
    app.setAppUserModelId('dev.giovanijunior.claude-widget')

    state = windowState.load(app)
    loadCache()
    loadCodexCache()
    loadKimiCache()
    loadGrokCache()
    createWindow()

    tray = new Tray(trayIcon('ok'))
    tray.on('click', toggleWindow)
    updateTray()

    refresh()
    refreshCodex()
    refreshKimi()
    refreshGrok()
    tickTimer = setInterval(tick, 1000)

    const wakeAll = () => {
      runtime.backoff = POLL_BASE_MS; refresh()
      if (codexRuntime.available) { codexRuntime.backoff = POLL_BASE_MS; refreshCodex() }
      if (kimiRuntime.available) { kimiRuntime.backoff = POLL_BASE_MS; refreshKimi() }
      if (grokRuntime.available) { grokRuntime.backoff = POLL_BASE_MS; refreshGrok() }
    }
    powerMonitor.on('resume', wakeAll)
    powerMonitor.on('unlock-screen', wakeAll)
    nativeTheme.on('updated', push)
  })

  app.on('window-all-closed', () => { /* vive na bandeja */ })
  app.on('before-quit', () => {
    quitting = true
    clearTimeout(pollTimer)
    clearTimeout(codexPollTimer)
    clearTimeout(kimiPollTimer)
    clearTimeout(grokPollTimer)
    clearInterval(tickTimer)
  })
}
