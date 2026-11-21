'use strict'

// OpenCode Go. A chave fica em ~/.local/share/opencode/auth.json, entrada
// "opencode-go", gravada pelo proprio OpenCode no login. O endpoint de uso do
// Go devolve as tres janelas do plano ja calculadas em percentual:
//   rolling (5 h), weekly (segunda 00:00 UTC) e monthly (periodo pago).
// So leitura: a chave e de API, nao expira nem precisa renovar.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CredsError } = require('./creds')
const { UsageError } = require('./usage')
const { toDate, whenLabel, dayWord, pctOf, countdown, severityFromPct } = require('./view-model')

const AUTH_PATH = process.env.CLAUDE_WIDGET_OPENCODE_AUTH_PATH ||
  path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
const USAGE_URL = process.env.CLAUDE_WIDGET_OPENCODE_USAGE_URL || 'https://opencode.ai/zen/go/v1/usage'
const PROVIDER_KEY = 'opencode-go'
const TIMEOUT_MS = 10_000

const clockFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

function parseAuth (text) {
  let json
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new CredsError('BAD_JSON', 'O arquivo de credenciais do OpenCode não é um JSON válido.')
  }
  const entry = json && json[PROVIDER_KEY]
  // OpenCode instalado mas sem o Go logado: nada a mostrar.
  if (!entry || typeof entry.key !== 'string' || entry.key === '') {
    throw new CredsError('NO_FILE', 'OpenCode sem login no plano Go nesta máquina.')
  }
  return { token: entry.key }
}

function readCreds () {
  let text
  try {
    text = fs.readFileSync(AUTH_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw new CredsError('NO_FILE', 'OpenCode não encontrado nesta máquina.')
    throw new CredsError('UNREADABLE', 'Não foi possível ler as credenciais do OpenCode.')
  }
  return parseAuth(text)
}

async function fetchOpencodeUsage (token) {
  let res
  try {
    res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'TIMEOUT' : 'OFFLINE'
    throw new UsageError(code, 'Não foi possível falar com a API do OpenCode.')
  }
  if (res.status === 401 || res.status === 403) {
    throw new UsageError('TOKEN_EXPIRED', 'A chave do OpenCode Go não é mais aceita.')
  }
  if (!res.ok) throw new UsageError('HTTP_ERROR', `A API do OpenCode respondeu ${res.status}.`)
  try {
    return await res.json()
  } catch {
    throw new UsageError('BAD_RESPONSE', 'A resposta do OpenCode não é um JSON válido.')
  }
}

// Janela bloqueada ("status" diferente de "ok") e vermelha mesmo abaixo de 90%.
function windowOf (w) {
  if (!w || typeof w !== 'object') return null
  const pct = pctOf(w.percent)
  if (pct == null) return null
  const blocked = typeof w.status === 'string' && w.status !== 'ok'
  return { pct, resetsAt: toDate(w.resetsAt), severity: blocked ? 'crit' : severityFromPct(pct) }
}

function toOpencodeViewModel (raw, now = Date.now()) {
  const u = raw && raw.usage
  if (!u || typeof u !== 'object') return { session: null, windows: [], spend: null, at: now }
  const rolling = windowOf(u.rolling)
  const rows = [['Semana', windowOf(u.weekly)], ['Mês', windowOf(u.monthly)]]
    .filter(([, w]) => w)
    .map(([name, w]) => ({ name, pct: w.pct, when: whenLabel(w.resetsAt, now), severity: w.severity }))

  return {
    session: rolling && {
      pct: rolling.pct,
      countdown: countdown(rolling.resetsAt, now),
      at: rolling.resetsAt ? `${dayWord(rolling.resetsAt, now)}, ${clockFmt.format(rolling.resetsAt)}` : null,
      severity: rolling.severity,
      label: '5 h'
    },
    windows: rows,
    spend: null,
    at: now
  }
}

module.exports = { readCreds, parseAuth, fetchOpencodeUsage, toOpencodeViewModel, AUTH_PATH, USAGE_URL }
