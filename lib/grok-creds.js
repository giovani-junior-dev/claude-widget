'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CredsError } = require('./creds')

const AUTH_PATH = process.env.CLAUDE_WIDGET_GROK_AUTH_PATH ||
  path.join(os.homedir(), '.grok', 'auth.json')

// Provedor da sessao "de verdade" do Grok Build: outras entradas no arquivo
// sao compatibilidade com issuers antigos, so usadas se essa nao existir.
const PREFERRED_ISSUER = 'https://auth.x.ai'

function isPreferredKey (key) {
  return key === PREFERRED_ISSUER || key.startsWith(`${PREFERRED_ISSUER}::`)
}

function sessionFromEntry (entry) {
  const expiresAt = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : null
  return {
    token: entry.key,
    userId: typeof entry.user_id === 'string' ? entry.user_id : null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    expired: Number.isFinite(expiresAt) ? Date.now() >= expiresAt - 60_000 : false
  }
}

// auth.json e um mapa {"<issuer>::<client_id>": {key, user_id, expires_at, ...}},
// nao um objeto plano feito Claude/Codex/Kimi.
function parse (text, now) {
  let json
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new CredsError('BAD_JSON', 'O arquivo de credenciais do Grok Build não é um JSON válido.')
  }
  if (!json || typeof json !== 'object') {
    throw new CredsError('BAD_SHAPE', 'Arquivo de credenciais do Grok Build com formato inesperado.')
  }

  let preferred = null
  let fallback = null
  for (const [key, entry] of Object.entries(json)) {
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || entry.key === '') continue
    if (isPreferredKey(key)) { preferred = entry; break }
    if (!fallback) fallback = entry
  }
  const chosen = preferred || fallback
  // Arquivo existe mas sem token (ex: apos "grok logout"): trata igual arquivo
  // ausente, nao como erro — nao ha nada de errado, so ninguem logado.
  if (!chosen) throw new CredsError('NO_FILE', 'Credenciais do Grok Build não encontradas nesta máquina.')

  return sessionFromEntry(chosen)
}

function readCreds (now = Date.now()) {
  let text
  try {
    text = fs.readFileSync(AUTH_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CredsError('NO_FILE', 'Credenciais do Grok Build não encontradas nesta máquina.')
    }
    throw new CredsError('UNREADABLE', 'Não foi possível ler o arquivo de credenciais do Grok Build.')
  }
  return parse(text, now)
}

module.exports = { readCreds, parse, AUTH_PATH, PREFERRED_ISSUER }
