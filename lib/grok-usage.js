'use strict'

const { UsageError } = require('./usage')

const DEFAULT_BASE = 'https://cli-chat-proxy.grok.com/v1'
const TIMEOUT_MS = 10_000

// Header de compatibilidade: sem ele a xAI recusa o pedido, mesmo com token valido.
const GROK_CLI_AUTH_HEADER = 'xai-grok-cli'

function endpoint () {
  const base = (process.env.CLAUDE_WIDGET_GROK_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  return `${base}/billing?format=credits`
}

async function fetchGrokUsage (token, userId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-XAI-Token-Auth': GROK_CLI_AUTH_HEADER,
    Accept: 'application/json'
  }
  if (userId) headers['x-userid'] = userId

  let res
  try {
    res = await fetch(endpoint(), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'TIMEOUT' : 'OFFLINE'
    throw new UsageError(code, 'Não foi possível falar com o billing do Grok.')
  }

  if (res.status === 401 || res.status === 403) {
    throw new UsageError('TOKEN_EXPIRED', 'A credencial local do Grok Build não é mais aceita.')
  }
  if (!res.ok) {
    throw new UsageError('HTTP_ERROR', `O billing do Grok respondeu ${res.status}.`)
  }

  try {
    return await res.json()
  } catch {
    throw new UsageError('BAD_RESPONSE', 'A resposta do billing do Grok não é um JSON válido.')
  }
}

module.exports = { fetchGrokUsage, DEFAULT_BASE, TIMEOUT_MS }
