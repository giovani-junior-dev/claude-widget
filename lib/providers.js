'use strict'

// Registro unico das fontes de consumo. Cada uma sabe ler a propria credencial,
// buscar o bruto e converter para o formato de tela comum (session/windows/spend).
// O ciclo (cache, recuo, agenda) vive no main e e o mesmo para todas.
//
// Contrato de load(ctx): devolve { raw, plan } ou lanca
//   - CredsError NO_FILE  -> ferramenta nunca usada nesta maquina (a aba some)
//   - UsageError/KimiOAuthError com code TOKEN_EXPIRED | OFFLINE | TIMEOUT | ...

const { readCreds, CredsError } = require('./creds')
const { fetchUsage, UsageError } = require('./usage')
const { toViewModel } = require('./view-model')
const codexCreds = require('./codex-creds')
const { fetchCodexUsage } = require('./codex-usage')
const { toCodexViewModel } = require('./codex-view-model')
const kimiCreds = require('./kimi-creds')
const kimiOauth = require('./kimi-oauth')
const { fetchKimiUsage } = require('./kimi-usage')
const { toKimiViewModel } = require('./kimi-view-model')
const grokCreds = require('./grok-creds')
const { fetchGrokUsage } = require('./grok-usage')
const { toGrokViewModel } = require('./grok-view-model')
const zcodeCreds = require('./zcode-creds')
const { fetchZcodeUsage } = require('./zcode-usage')
const { toZcodeViewModel, zcodePlan } = require('./zcode-view-model')
const antigravityCreds = require('./antigravity-creds')
const { fetchAntigravityUsage } = require('./antigravity-usage')
const { toAntigravityViewModel, antigravityPlan } = require('./antigravity-view-model')
const { fetchQwenUsage } = require('./qwen-usage')
const { toQwenViewModel } = require('./qwen-view-model')
const { toQwenCloudViewModel } = require('./qwencloud')
const opencode = require('./opencode')

const expired = () => new UsageError('TOKEN_EXPIRED', null)

const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    required: true, // e a razao de existir do widget: nunca some, mesmo sem login
    cacheFile: 'last-usage.json',
    hint: 'Abra o Claude Code uma vez para renovar; o widget volta sozinho.',
    async load () {
      const creds = readCreds()
      if (creds.expired) throw Object.assign(expired(), { plan: creds.plan })
      return { raw: await fetchUsage(creds.token), plan: creds.plan }
    },
    toVM: toViewModel
  },
  {
    id: 'codex',
    label: 'Codex',
    cacheFile: 'last-codex-usage.json',
    hint: 'Abra o Codex CLI uma vez para renovar o login.',
    async load () {
      const creds = codexCreds.readCreds()
      if (creds.expired) throw expired()
      const raw = await fetchCodexUsage(creds.token)
      return { raw, plan: typeof raw.plan_type === 'string' ? raw.plan_type : creds.plan }
    },
    toVM: toCodexViewModel
  },
  {
    id: 'kimi',
    label: 'Kimi',
    cacheFile: 'last-kimi-usage.json',
    hint: 'Faça login de novo no Kimi Code.',
    async load () {
      const creds = kimiCreds.readCreds()
      // Token dura so 15 min: quase toda leitura passa por aqui. Regrava o par
      // novo no arquivo do CLI real, senao o login dele quebra na proxima vez.
      let accessToken = creds.accessToken
      if (creds.expired) {
        const refreshed = await kimiOauth.refreshAccessToken(creds.refreshToken)
        kimiCreds.writeCreds(refreshed)
        accessToken = refreshed.access_token
      }
      return { raw: await fetchKimiUsage(accessToken), plan: null }
    },
    toVM: toKimiViewModel
  },
  {
    id: 'grok',
    label: 'Grok',
    cacheFile: 'last-grok-usage.json',
    hint: 'Abra o Grok Build uma vez para renovar o login.',
    async load () {
      // So leitura: o Grok Build renova o proprio token na proxima vez que rodar.
      const creds = grokCreds.readCreds()
      if (creds.expired) throw expired()
      return { raw: await fetchGrokUsage(creds.token, creds.userId), plan: null }
    },
    toVM: toGrokViewModel
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    cacheFile: 'last-antigravity-usage.json',
    hint: 'Abra o Antigravity ou rode o agy uma vez para renovar o login.',
    async load () {
      // So leitura: o agy fica em segundo plano e renova o token sozinho.
      const creds = await antigravityCreds.readCreds()
      if (creds.expired) throw expired()
      const raw = await fetchAntigravityUsage(creds.token)
      return { raw, plan: antigravityPlan(raw) }
    },
    toVM: toAntigravityViewModel
  },
  {
    id: 'zcode',
    label: 'ZCode',
    cacheFile: 'last-zcode-usage.json',
    hint: 'Abra o ZCode e entre de novo com a conta Z.ai.',
    async load () {
      const creds = zcodeCreds.readCreds()
      const raw = await fetchZcodeUsage(creds.token)
      return { raw, plan: zcodePlan(raw) }
    },
    toVM: toZcodeViewModel
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    cacheFile: 'last-opencode-usage.json',
    hint: 'Faça login de novo no OpenCode com a chave do plano Go.',
    async load () {
      const creds = opencode.readCreds()
      return { raw: await opencode.fetchOpencodeUsage(creds.token), plan: 'go' }
    },
    toVM: opencode.toOpencodeViewModel
  },
  {
    id: 'qwen',
    label: 'Qwen',
    cacheFile: 'last-qwen-usage.json',
    hint: 'Reconecte a QwenCloud em "Conectar QwenCloud", no menu da bandeja.',
    // Dois caminhos: com a QwenCloud conectada, le o Token Plan oficial do
    // console (ctx.qwenCloud, so o main tem janela para isso). Sem conexao, conta
    // as requisicoes do Coding Plan no historico local do Qwen Code.
    async load (ctx = {}) {
      if (ctx.qwenCloud) {
        const raw = await ctx.qwenCloud()
        return { raw: { kind: 'tokenplan', ...raw }, plan: raw.plan }
      }
      const raw = await fetchQwenUsage({ tier: ctx.qwenTier })
      return { raw: { kind: 'local', ...raw }, plan: raw.tier }
    },
    toVM: (raw, now) => raw && raw.kind === 'tokenplan' ? toQwenCloudViewModel(raw, now) : toQwenViewModel(raw, now)
  }
]

const BY_ID = Object.fromEntries(PROVIDERS.map(p => [p.id, p]))

// Traduz qualquer erro do load para o estado que a tela entende.
function classify (err) {
  if (err instanceof CredsError) {
    return err.code === 'NO_FILE' ? { status: 'missing', message: err.message } : { status: 'error', message: err.message }
  }
  const code = err && err.code
  if (code === 'TOKEN_EXPIRED') return { status: 'expired', message: null }
  if (code === 'OFFLINE' || code === 'TIMEOUT') return { status: 'offline', message: null }
  return { status: 'error', message: (err && err.message) || 'Erro inesperado.' }
}

module.exports = { PROVIDERS, BY_ID, classify }
