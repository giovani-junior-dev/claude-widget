'use strict'

// Renovacao do token do Kimi Code: mesmo endpoint, client_id e grant_type que
// o CLI oficial usa (packages/oauth/src/oauth.ts + constants.ts do
// MoonshotAI/kimi-code, repo publico). client_id nao e segredo, e o mesmo
// valor embutido no binario do CLI real.

const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const OAUTH_HOST = (process.env.CLAUDE_WIDGET_KIMI_OAUTH_HOST || 'https://auth.kimi.com').replace(/\/$/, '')
const TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`
const TIMEOUT_MS = 10_000

class KimiOAuthError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'KimiOAuthError'
    this.code = code
  }
}

async function refreshAccessToken (refreshToken) {
  let res
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'TIMEOUT' : 'OFFLINE'
    throw new KimiOAuthError(code, 'Não foi possível falar com o login do Kimi Code.')
  }

  let data = {}
  try { data = await res.json() } catch { /* corpo vazio ou invalido, trata pelo status abaixo */ }

  if (res.status === 401 || res.status === 403 || data.error === 'invalid_grant') {
    throw new KimiOAuthError('TOKEN_EXPIRED', 'A credencial local do Kimi Code não é mais aceita.')
  }
  if (res.status !== 200 || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
    throw new KimiOAuthError('HTTP_ERROR', `A renovação do token do Kimi Code respondeu ${res.status}.`)
  }

  const expiresIn = Number(data.expires_in)
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 0),
    scope: typeof data.scope === 'string' ? data.scope : '',
    token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    expires_in: Number.isFinite(expiresIn) ? expiresIn : 0
  }
}

module.exports = { refreshAccessToken, KimiOAuthError, CLIENT_ID, TOKEN_URL }
