'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CredsError } = require('./creds')

const CREDS_PATH = process.env.CLAUDE_WIDGET_CODEX_CREDS_PATH ||
  path.join(os.homedir(), '.codex', 'auth.json')

const EXPIRY_SKEW_MS = 60_000

// access_token e um JWT: decodifica so o payload (sem checar assinatura) pra ler
// "exp" e o plano. Quem valida de verdade e o backend, na proxima requisicao.
function decodePayload (jwt) {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function parse (text, now) {
  let json
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new CredsError('BAD_JSON', 'O arquivo de credenciais do Codex não é um JSON válido.')
  }

  const token = json && json.tokens && json.tokens.access_token
  if (typeof token !== 'string' || token === '') {
    throw new CredsError('BAD_SHAPE', 'Credencial do Codex sem token de acesso utilizável.')
  }

  const payload = decodePayload(token) || {}
  const auth = payload['https://api.openai.com/auth'] || {}
  const expiresAt = typeof payload.exp === 'number' ? payload.exp * 1000 : null

  return {
    token,
    expiresAt,
    plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null,
    expired: expiresAt != null && now >= expiresAt - EXPIRY_SKEW_MS
  }
}

// Mesmo truque de renomeacao atomica do Claude Code: o Codex CLI tambem troca
// esse arquivo inteiro ao renovar o token.
function readCreds (now = Date.now()) {
  let text
  try {
    text = fs.readFileSync(CREDS_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CredsError('NO_FILE', 'Credenciais do Codex CLI não encontradas nesta máquina.')
    }
    try {
      text = fs.readFileSync(CREDS_PATH, 'utf8')
    } catch {
      throw new CredsError('UNREADABLE', 'Não foi possível ler o arquivo de credenciais do Codex.')
    }
  }
  return parse(text, now)
}

module.exports = { readCreds, parse, CREDS_PATH, EXPIRY_SKEW_MS }
