'use strict'

const path = require('node:path')
const fs = require('node:fs')
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  powerMonitor, shell, nativeImage
} = require('electron')
const { autoUpdater } = require('electron-updater')

const { PROVIDERS, BY_ID, classify } = require('./lib/providers')
const { worstSeverity } = require('./lib/view-model')
const { TIERS: QWEN_TIERS } = require('./lib/qwen-usage')
const windowState = require('./lib/window-state')
const autostart = require('./lib/autostart')
const tokenUsage = require('./lib/token-usage')
const { nextBackoff, BASE_MS: POLL_BASE_MS } = require('./lib/poll-policy')

// A aba de tokens le arquivos do disco, nao a API: ritmo proprio, e so quando aberta.
const TOKENS_REFRESH_MS = 60_000

// A janela e uma tela transparente fixa no topo; a ilha desenhada dentro dela
// cresce e encolhe sem redimensionar a janela (redimensionar treme no Windows).
const WIN_W = 500
const WIN_H = 660
const TOP_GAP = 8

let win = null
let tray = null
let state = null
let tickTimer = null
let hoverTimer = null
let quitting = false

// ---------------------------------------------------------------- estado por fonte

const runtimes = Object.fromEntries(PROVIDERS.map(p => [p.id, {
  raw: null, // ultima resposta crua boa
  vm: null, // modelo derivado
  at: null, // quando a resposta chegou
  status: 'loading',
  message: null,
  stale: false,
  plan: null,
  backoff: POLL_BASE_MS,
  available: true, // vira false so quando a ferramenta nunca rodou nesta maquina
  busy: false, // trava reentrancia: o refresh do Kimi rotaciona o token no disco
  timer: null
}]))

const tokens = { data: null, at: 0, busy: false } // aba de tokens, so do Claude

// ---------------------------------------------------------------- cache

function cachePath (name) {
  return path.join(app.getPath('userData'), name)
}

function saveCache (p) {
  const r = runtimes[p.id]
  if (!r.vm) return
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(cachePath(p.cacheFile), JSON.stringify({ vm: r.vm, at: r.at, plan: r.plan }))
  } catch { /* cache e conveniencia, nao requisito */ }
}

// Abrir ja com numero, mesmo antes da primeira resposta. Sempre marcado como velho.
function loadCache (p) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(p.cacheFile), 'utf8'))
    if (c && c.vm) Object.assign(runtimes[p.id], { vm: c.vm, at: c.at, plan: c.plan || null, stale: true })
  } catch { /* primeira execucao */ }
}

// ---------------------------------------------------------------- ciclo

async function refresh (id) {
  const p = BY_ID[id]
  const r = runtimes[id]
  if (!p || r.busy) return
  r.busy = true
  try {
    const { raw, plan } = await p.load({ qwenTier: state.qwenTier })
    r.raw = raw
    r.at = Date.now()
    r.vm = p.toVM(raw, r.at)
    r.plan = plan || r.plan
    r.status = 'ok'
    r.message = null
    r.stale = false
    r.available = true
    r.backoff = nextBackoff(r.backoff, true)
    saveCache(p)
  } catch (err) {
    if (err && err.plan) r.plan = err.plan
    let { status, message } = classify(err)
    if (status === 'missing') {
      if (!p.required) {
        // Ferramenta nunca usada aqui: nada pra mostrar, para de bater no disco.
        r.available = false
        r.status = 'missing'
        if (state.source === id) setState({ source: 'claude' })
        return
      }
      status = 'expired'
    }
    r.status = status
    r.message = message
    r.stale = true
    r.backoff = nextBackoff(r.backoff, false)
  } finally {
    r.busy = false
    push()
    schedule(id)
  }
}

function schedule (id) {
  const r = runtimes[id]
  clearTimeout(r.timer)
  if (!r.available) return
  // Janela escondida com icone estatico: nada muda na tela, nao ha o que buscar.
  if (win && !win.isVisible() && r.status === 'ok') return
  r.timer = setTimeout(() => refresh(id), r.backoff)
}

function refreshAll ({ force = false } = {}) {
  for (const p of PROVIDERS) {
    const r = runtimes[p.id]
    if (!r.available && !force) continue
    if (force) r.backoff = POLL_BASE_MS
    refresh(p.id)
  }
}

// Ao reabrir: busca so o que esta velho; o resto volta ao ritmo normal.
function refreshStale () {
  for (const p of PROVIDERS) {
    const r = runtimes[p.id]
    if (!r.available) continue
    if (r.status !== 'ok' || Date.now() - (r.at || 0) > POLL_BASE_MS) refresh(p.id)
    else schedule(p.id)
  }
}

function setState (patch) {
  state = { ...state, ...patch }
  windowState.save(app, state)
}

// ---------------------------------------------------------------- tela

function snapshot (p) {
  const r = runtimes[p.id]
  return {
    id: p.id,
    label: p.label,
    available: p.required || r.available,
    status: r.status,
    message: r.message,
    hint: p.hint,
    stale: r.stale,
    plan: r.plan,
    vm: r.vm,
    age: r.at ? Date.now() - r.at : null,
    local: !!p.local
  }
}

function push () {
  if (win && !win.isDestroyed()) {
    win.webContents.send('state', {
      providers: PROVIDERS.map(snapshot),
      source: state.source,
      tokensOpen: state.tokensOpen,
      tokens: tokens.data,
      tokenDays: state.tokenDays,
      tokensBusy: tokens.busy
    })
  }
  updateTray()
}

// Uma fonte de verdade para a contagem regressiva: o modelo e rederivado do
// bruto a cada segundo, em vez de o renderer manter um relogio proprio.
function tick () {
  if (!win || !win.isVisible()) return
  const now = Date.now()
  for (const p of PROVIDERS) {
    const r = runtimes[p.id]
    if (r.status === 'ok' && r.raw) r.vm = p.toVM(r.raw, now)
  }
  if (state.tokensOpen && state.source === 'claude') refreshTokens()
  push()
}

// ---------------------------------------------------------------- tokens

function tokenIndexFile () {
  return path.join(app.getPath('userData'), 'token-index.json')
}

// Roda so com a aba aberta. A leitura e assincrona por linha, entao a janela
// continua respondendo mesmo na primeira varredura, que e a cara.
async function refreshTokens (force = false) {
  if (tokens.busy) return
  if (!force && Date.now() - tokens.at < TOKENS_REFRESH_MS) return
  tokens.busy = true
  push() // acende o indicador: a primeira varredura de 90 dias demora alguns segundos
  try {
    tokens.data = await tokenUsage.collect(tokenIndexFile(), Date.now(), state.tokenDays)
    tokens.at = Date.now()
  } catch (err) {
    console.error('tokens:', err.message)
    tokens.data = { days: state.tokenDays, models: [], totalOutput: 0, at: Date.now() }
  } finally {
    tokens.busy = false
    push()
  }
}

// ---------------------------------------------------------------- bandeja

function trayIcon (severity) {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', `tray-${severity}.png`))
  return img.isEmpty() ? nativeImage.createEmpty() : img
}

function visibleProviders () {
  return PROVIDERS.filter(p => p.required || runtimes[p.id].available)
}

function trayTooltip () {
  const parts = []
  for (const p of visibleProviders()) {
    const vm = runtimes[p.id].vm
    const pct = vm && vm.session ? vm.session.pct : (vm && vm.windows[0] ? vm.windows[0].pct : null)
    if (pct != null) parts.push(`${p.label} ${pct}%`)
  }
  // Tooltip do Windows corta em 127 caracteres.
  return (parts.length ? parts.join(' · ') : 'Consumo de IA').slice(0, 127)
}

// Pior severidade entre as fontes disponiveis, nao so a que esta na tela. Uma
// fonte com erro (token expirado, offline) tambem conta como aviso, senao o
// icone volta pra verde escondendo o problema.
function combinedSeverity () {
  const sevs = visibleProviders().map(p => {
    const r = runtimes[p.id]
    return r.status === 'ok' && r.vm ? worstSeverity(r.vm) : 'warn'
  })
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
    // __dirname, nao app.getAppPath(): este e sempre a pasta do main.
    autostart.set(shell, on, process.execPath, __dirname)
  } catch (err) {
    console.error('autostart:', err.message)
  }
  updateTray()
}

function buildMenu () {
  const displays = screen.getAllDisplays()
  const current = targetDisplay()
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Ocultar' : 'Mostrar', click: toggleWindow },
    { label: 'Atualizar agora', click: () => refreshAll({ force: true }) },
    { type: 'separator' },
    {
      label: 'Monitor',
      enabled: displays.length > 1,
      submenu: displays.map((d, i) => ({
        label: `Tela ${i + 1}${d.id === screen.getPrimaryDisplay().id ? ' (principal)' : ''} · ${d.size.width}×${d.size.height}`,
        type: 'radio',
        checked: d.id === current.id,
        click: () => { setState({ displayId: d.id }); placeWindow() }
      }))
    },
    {
      label: 'Plano do Qwen',
      visible: runtimes.qwen.available,
      submenu: Object.keys(QWEN_TIERS).map(t => ({
        label: t === 'lite' ? 'Coding Plan Lite' : 'Coding Plan Pro',
        type: 'radio',
        checked: (state.qwenTier || 'lite') === t,
        click: () => { setState({ qwenTier: t }); refresh('qwen') }
      }))
    },
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

function targetDisplay () {
  return screen.getAllDisplays().find(d => d.id === state.displayId) || screen.getPrimaryDisplay()
}

// Centro do topo da area util, como a ilha do iPhone.
function placeWindow () {
  if (!win) return
  const a = targetDisplay().workArea
  win.setBounds({ x: Math.round(a.x + (a.width - WIN_W) / 2), y: a.y + TOP_GAP, width: WIN_W, height: Math.min(WIN_H, a.height - TOP_GAP) })
}

function toggleWindow () {
  if (!win) return
  if (win.isVisible()) {
    win.hide()
  } else {
    win.showInactive()
    refreshStale()
  }
  updateTray()
}

function createWindow () {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Acima de quase tudo, como a ilha: inclusive de janelas "sempre no topo".
  win.setAlwaysOnTop(true, 'screen-saver')
  // A area transparente deixa o clique passar; o renderer liga a captura
  // so enquanto o mouse esta sobre a ilha.
  win.setIgnoreMouseEvents(true)
  placeWindow()

  win.loadFile('index.html')
  win.once('ready-to-show', () => { win.showInactive(); push() })

  win.on('close', e => {
    if (quitting) return
    e.preventDefault()
    win.hide()
    updateTray()
  })
}

// ---------------------------------------------------------------- ipc

ipcMain.on('refresh', (_e, id) => {
  if (id && BY_ID[id]) {
    runtimes[id].backoff = POLL_BASE_MS
    refresh(id)
  } else {
    refreshAll({ force: true })
  }
})

ipcMain.on('hide', () => { if (win) { win.hide(); updateTray() } })

// O renderer informa onde a ilha esta dentro da janela, a cada mudanca de tamanho.
let islandRect = null
ipcMain.on('island-rect', (_e, r) => {
  if (r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) islandRect = r
})

// Hover por consulta ao cursor: no Windows o encaminhamento de mousemove de
// janela transparente atravessavel nao chega ao renderer. Fora da ilha o clique
// passa para o que esta embaixo; dentro, a ilha captura.
let hoverInside = false
function pollHover () {
  if (!win || win.isDestroyed() || !win.isVisible() || !islandRect) return
  const c = screen.getCursorScreenPoint()
  const b = win.getBounds()
  const PAD = 2
  const inside = c.x >= b.x + islandRect.x - PAD && c.x <= b.x + islandRect.x + islandRect.w + PAD &&
                 c.y >= b.y + islandRect.y - PAD && c.y <= b.y + islandRect.y + islandRect.h + PAD
  if (inside === hoverInside) return
  hoverInside = inside
  win.setIgnoreMouseEvents(!inside)
  win.webContents.send('hover', inside)
}

ipcMain.on('set-source', (_e, source) => {
  const p = BY_ID[source]
  if (!p || (!p.required && !runtimes[source].available) || source === state.source) return
  setState({ source })
  push()
  // Fonte que ainda nao tem dado nenhum: busca na hora, sem esperar o ciclo.
  if (runtimes[source].at == null) refresh(source)
  if (source === 'claude' && state.tokensOpen) refreshTokens()
})

ipcMain.on('toggle-tokens', () => {
  setState({ tokensOpen: !state.tokensOpen })
  push()
  if (state.tokensOpen) refreshTokens()
})

ipcMain.on('set-token-days', (_e, days) => {
  if (!tokenUsage.WINDOW_CHOICES.includes(days) || days === state.tokenDays) return
  setState({ tokenDays: days })
  push()
  refreshTokens(true) // periodo novo: recalcula na hora, sem esperar o minuto
})

// ---------------------------------------------------------------- vida

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.showInactive(); refreshStale(); updateTray() } })

  app.whenReady().then(() => {
    app.setAppUserModelId('dev.giovanijunior.claude-widget')

    state = windowState.load(app)
    if (!BY_ID[state.source]) state.source = 'claude'
    PROVIDERS.forEach(loadCache)
    createWindow()

    tray = new Tray(trayIcon('ok'))
    tray.on('click', toggleWindow)
    updateTray()

    refreshAll()
    tickTimer = setInterval(tick, 1000)
    hoverTimer = setInterval(pollHover, 50)

    // Checa 1x na abertura, sem agendamento proprio: quem reabre o app no dia
    // seguinte ja cobre o ritmo de verificacao.
    autoUpdater.checkForUpdatesAndNotify().catch(err => console.error('update:', err.message))

    const wake = () => refreshAll({ force: true })
    powerMonitor.on('resume', wake)
    powerMonitor.on('unlock-screen', wake)
    // Monitor plugado, desplugado ou com resolucao trocada: recentraliza.
    screen.on('display-metrics-changed', placeWindow)
    screen.on('display-added', placeWindow)
    screen.on('display-removed', placeWindow)
  })

  app.on('window-all-closed', () => { /* vive na bandeja */ })
  app.on('before-quit', () => {
    quitting = true
    for (const r of Object.values(runtimes)) clearTimeout(r.timer)
    clearInterval(tickTimer)
    clearInterval(hoverTimer)
  })
}
