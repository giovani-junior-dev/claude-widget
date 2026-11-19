'use strict'

const { UsageError } = require('./usage')

// Mesmo host que o agy usa: o "daily" reflete o consumo do CLI e do app.
const DEFAULT_BASE = 'https://daily-cloudcode-pa.googleapis.com'
const TIMEOUT_MS = 12_000

function base () {
  return (process.env.CLAUDE_WIDGET_ANTIGRAVITY_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
}

async function post (path, token, body) {
  let res
  try {
    res = await fetch(base() + path, {
      method: 'POST',
      // Sem esse User-Agent a API trata o pedido como Gemini Code Assist e recusa a cota.
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'antigravity' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'TIMEOUT' : 'OFFLINE'
    throw new UsageError(code, 'Não foi possível falar com a API do Antigravity.')
  }
  if (res.status === 401 || res.status === 403) {
    throw new UsageError('TOKEN_EXPIRED', 'A credencial local do Antigravity não é mais aceita.')
  }
  if (!res.ok) throw new UsageError('HTTP_ERROR', `A API do Antigravity respondeu ${res.status}.`)
  try {
    return await res.json()
  } catch {
    throw new UsageError('BAD_RESPONSE', 'A resposta do Antigravity não é um JSON válido.')
  }
}

// loadCodeAssist devolve o projeto e o plano; fetchAvailableModels traz a cota
// de 5 h por modelo; retrieveUserQuotaSummary traz semana + 5 h por grupo.
async function fetchAntigravityUsage (token) {
  const assist = await post('/v1internal:loadCodeAssist', token, { metadata: { ideType: 'ANTIGRAVITY' } })
  const project = assist && assist.cloudaicompanionProject
  const projectId = typeof project === 'string' ? project : (project && project.id)
  const body = projectId ? { project: projectId } : {}
  const models = await post('/v1internal:fetchAvailableModels', token, body)
  // Resumo por grupo, com janela semanal e de 5 h: o mesmo que o /credits do agy
  // mostra. Hoje so vem o grupo Claude/GPT; se falhar, a cota por modelo basta.
  const summary = await post('/v1internal:retrieveUserQuotaSummary', token, body).catch(() => null)
  return {
    tier: (assist && (assist.paidTier || assist.currentTier)) || null,
    models: (models && models.models) || {},
    groups: (summary && Array.isArray(summary.groups)) ? summary.groups : []
  }
}

module.exports = { fetchAntigravityUsage, DEFAULT_BASE, TIMEOUT_MS }
