'use strict'

const { UsageError } = require('./usage')

const DEFAULT_URL = 'https://api.kimi.com/coding/v1/usages'
const TIMEOUT_MS = 10_000

function endpoint () {
  return process.env.CLAUDE_WIDGET_KIMI_USAGE_URL || DEFAULT_URL
}

async function fetchKimiUsage (accessToken) {
  let res
  try {
    res = await fetch(endpoint(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'TIMEOUT' : 'OFFLINE'
    throw new UsageError(code, 'Não foi possível falar com a plataforma do Kimi Code.')
  }

  if (res.status === 401 || res.status === 403) {
    throw new UsageError('TOKEN_EXPIRED', 'A credencial local do Kimi Code não é mais aceita.')
  }
  if (!res.ok) {
    throw new UsageError('HTTP_ERROR', `A plataforma do Kimi Code respondeu ${res.status}.`)
  }

  try {
    return await res.json()
  } catch {
    throw new UsageError('BAD_RESPONSE', 'A resposta da plataforma do Kimi Code não é um JSON válido.')
  }
}

module.exports = { fetchKimiUsage, DEFAULT_URL, TIMEOUT_MS }
