'use strict'

const { UsageError } = require('./usage')

const DEFAULT_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TIMEOUT_MS = 10_000

// URL sobrescrevivel para forcar o caminho offline nos testes manuais.
function endpoint () {
  return process.env.CLAUDE_WIDGET_CODEX_USAGE_URL || DEFAULT_URL
}

async function fetchCodexUsage (token) {
  let res
  try {
    res = await fetch(endpoint(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'TIMEOUT' : 'OFFLINE'
    throw new UsageError(code, 'Não foi possível falar com o backend do ChatGPT.')
  }

  if (res.status === 401 || res.status === 403) {
    throw new UsageError('TOKEN_EXPIRED', 'A credencial local do Codex não é mais aceita.')
  }
  if (!res.ok) {
    throw new UsageError('HTTP_ERROR', `O backend do Codex respondeu ${res.status}.`)
  }

  try {
    return await res.json()
  } catch {
    throw new UsageError('BAD_RESPONSE', 'A resposta do backend do Codex não é um JSON válido.')
  }
}

module.exports = { fetchCodexUsage, DEFAULT_URL, TIMEOUT_MS }
