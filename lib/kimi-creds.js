'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { CredsError } = require('./creds')

const CREDS_DIR = process.env.CLAUDE_WIDGET_KIMI_CREDS_DIR ||
  path.join(os.homedir(), '.kimi-code', 'credentials')
const CREDS_PATH = path.join(CREDS_DIR, 'kimi-code.json')

// Token de acesso do Kimi Code dura so 15 min (expires_in do proprio provedor),
// bem menor que a folga usada pro Claude/Codex: sem isso, quase toda leitura
// cairia no caminho de refresh mesmo com o token ainda tecnicamente valido.
const EXPIRY_SKEW_MS = 20_000

function parse (text, now) {
  let json
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new CredsError('BAD_JSON', 'O arquivo de credenciais do Kimi Code não é um JSON válido.')
  }

  const accessToken = json && json.access_token
  const refreshToken = json && json.refresh_token
  if (typeof accessToken !== 'string' || accessToken === '' ||
      typeof refreshToken !== 'string' || refreshToken === '') {
    throw new CredsError('BAD_SHAPE', 'Credencial do Kimi Code sem token utilizável.')
  }

  const expiresAt = typeof json.expires_at === 'number' ? json.expires_at * 1000 : null
  return {
    accessToken,
    refreshToken,
    expiresAt,
    expired: expiresAt == null || now >= expiresAt - EXPIRY_SKEW_MS
  }
}

// Mesmo arquivo que o Kimi Code CLI le: ~/.kimi-code/credentials/kimi-code.json.
function readCreds (now = Date.now()) {
  let text
  try {
    text = fs.readFileSync(CREDS_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CredsError('NO_FILE', 'Credenciais do Kimi Code não encontradas nesta máquina.')
    }
    throw new CredsError('UNREADABLE', 'Não foi possível ler o arquivo de credenciais do Kimi Code.')
  }
  return parse(text, now)
}

// Mesma escrita atomica que o proprio Kimi Code CLI usa (tmp + fsync + rename):
// sem regravar aqui, um refresh_token novo devolvido pelo provedor deixaria o
// arquivo do CLI real com a versao velha, e o proximo login dele quebraria.
function writeCreds (wire) {
  fs.mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${CREDS_PATH}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  const data = Buffer.from(JSON.stringify(wire, null, 2) + '\n', 'utf8')
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, CREDS_PATH)
}

module.exports = { readCreds, writeCreds, parse, CREDS_PATH, EXPIRY_SKEW_MS }
