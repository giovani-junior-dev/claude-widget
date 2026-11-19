'use strict'

const { UsageError } = require('./usage')

// Mesmo endpoint que o painel de uso do ZCode consulta para o Coding Plan da Z.ai.
const DEFAULT_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'
const TIMEOUT_MS = 10_000

function endpoint () {
  return process.env.CLAUDE_WIDGET_ZCODE_USAGE_URL || DEFAULT_URL
}

async function fetchZcodeUsage (token) {
  let res
  try {
    res = await fetch(endpoint(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Language': 'en-US,en' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'TIMEOUT' : 'OFFLINE'
    throw new UsageError(code, 'Não foi possível falar com a API da Z.ai.')
  }
  if (res.status === 401 || res.status === 403) {
    throw new UsageError('TOKEN_EXPIRED', 'A credencial local do ZCode não é mais aceita.')
  }
  if (!res.ok) throw new UsageError('HTTP_ERROR', `A API da Z.ai respondeu ${res.status}.`)

  let json
  try {
    json = await res.json()
  } catch {
    throw new UsageError('BAD_RESPONSE', 'A resposta da Z.ai não é um JSON válido.')
  }
  // A Z.ai responde 200 com o erro dentro do corpo.
  if (json && json.code === 401) {
    throw new UsageError('TOKEN_EXPIRED', 'A credencial local do ZCode não é mais aceita.')
  }
  if (json && json.success === false) {
    throw new UsageError('HTTP_ERROR', `A Z.ai recusou a consulta: ${json.msg || json.code}.`)
  }
  return json
}

module.exports = { fetchZcodeUsage, DEFAULT_URL, TIMEOUT_MS }
