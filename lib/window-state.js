'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = { x: null, y: null, compact: false, pinned: true, tokensOpen: false, tokenDays: 7, source: 'claude' }

function file (app) {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function load (app) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(app), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save (app, state) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(file(app), JSON.stringify(state))
  } catch {
    // Posicao nao e critica: perder isso nao justifica derrubar o widget.
  }
}

// Sem isso o widget some quando um monitor e desconectado: a posicao salva
// continua valida no arquivo, mas nao existe mais tela naquelas coordenadas.
function visibleOn (screen, x, y, width, height) {
  if (x == null || y == null) return false
  return screen.getAllDisplays().some(d => {
    const a = d.workArea
    return x + width > a.x && x < a.x + a.width &&
           y + height > a.y && y < a.y + a.height
  })
}

function placement (screen, state, width, height) {
  if (visibleOn(screen, state.x, state.y, width, height)) {
    return { x: state.x, y: state.y }
  }
  const a = screen.getPrimaryDisplay().workArea
  return { x: a.x + a.width - width - 24, y: a.y + 24 }
}

module.exports = { load, save, placement, visibleOn, DEFAULTS }
