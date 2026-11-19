'use strict'

const fs = require('node:fs')
const path = require('node:path')

// dock: onde a ilha foi solta (null = centro do topo). hidden: fontes que o usuario escondeu.
const DEFAULTS = { tokensOpen: false, tokenDays: 7, source: 'claude', displayId: null, qwenTier: 'lite', qwenCloud: false, dock: null, hidden: [] }

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
    // Preferencia nao e critica: perder isso nao justifica derrubar o widget.
  }
}

module.exports = { load, save, DEFAULTS }
