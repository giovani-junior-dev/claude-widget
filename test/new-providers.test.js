'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NOW = Date.parse('2026-11-19T04:30:00.000Z')

// ---------------------------------------------------------------- ZCode / Z.ai

const zcode = require('../lib/zcode-creds')
const { toZcodeViewModel, zcodePlan } = require('../lib/zcode-view-model')

// Estrutura real de /api/monitor/usage/quota/limit, valores de exemplo.
const zaiQuota = {
  code: 200,
  success: true,
  data: {
    level: 'lite',
    limits: [
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 45, remaining: 9954, percentage: 1, nextResetTime: NOW + 5 * 86400_000 },
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 45, remaining: 1954, percentage: 2, nextResetTime: NOW + 2 * 3600_000 + 10 * 60_000 }
    ]
  }
}

test('zcode: credencial cifrada pelo app e aberta com a mesma chave', () => {
  const key = zcode.cipherKey('segredo-de-teste')
  const file = JSON.stringify({ [zcode.TOKEN_KEY]: zcode.encrypt('tok-123', key) })
  assert.equal(zcode.parse(file, key).token, 'tok-123')
})

test('zcode: chave errada vira erro nomeado, sem vazar o conteudo', () => {
  const file = JSON.stringify({ [zcode.TOKEN_KEY]: zcode.encrypt('tok-123', zcode.cipherKey('a')) })
  assert.throws(() => zcode.parse(file, zcode.cipherKey('b')), err => err.code === 'BAD_KEY' && !err.message.includes('tok-123'))
})

test('zcode: arquivo sem login da Z.ai conta como ferramenta ausente', () => {
  assert.throws(() => zcode.parse('{}', zcode.cipherKey('x')), err => err.code === 'NO_FILE')
})

test('zcode: segredo padrao segue o fallback do proprio ZCode', () => {
  assert.match(zcode.defaultSecret({}), /^zcode-credential-fallback:/)
  assert.equal(zcode.defaultSecret({ ZCODE_CREDENTIAL_SECRET: 's' }), 's')
})

test('zcode: janela de 5 h vira o mostrador, semana vira linha', () => {
  const vm = toZcodeViewModel(zaiQuota, NOW)
  assert.equal(vm.session.pct, 2)
  assert.equal(vm.session.label, '5 h')
  assert.equal(vm.session.countdown, '2 h 10')
  assert.deepEqual(vm.windows.map(w => [w.name, w.pct]), [['Semana', 1]])
  assert.equal(zcodePlan(zaiQuota), 'lite')
})

test('zcode: sem percentage, calcula pelo usado sobre o limite', () => {
  const raw = { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 200, currentValue: 150, nextResetTime: NOW + 60_000 * 30 }] } }
  assert.equal(toZcodeViewModel(raw, NOW).session.pct, 75)
  assert.equal(toZcodeViewModel(raw, NOW).session.severity, 'warn')
})

test('zcode: so cota longa nao inventa mostrador', () => {
  const raw = { data: { limits: [zaiQuota.data.limits[0]] } }
  const vm = toZcodeViewModel(raw, NOW)
  assert.equal(vm.session, null)
  assert.equal(vm.windows.length, 1)
})

test('zcode: resposta vazia ou estranha nao derruba a conversao', () => {
  for (const raw of [null, {}, { data: {} }, { data: { limits: 'x' } }]) {
    assert.deepEqual(toZcodeViewModel(raw, NOW).windows, [])
  }
})

// ---------------------------------------------------------------- Antigravity

const { toAntigravityViewModel, antigravityPlan } = require('../lib/antigravity-view-model')
const { parse: parseAntigravity } = require('../lib/antigravity-creds')

const reset1 = '2026-11-19T09:20:19Z'
const reset2 = '2026-11-19T09:23:58Z'
const agModels = {
  tier: { id: 'free-tier', name: 'Antigravity' },
  models: {
    'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.6, resetTime: reset1 } },
    'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', quotaInfo: { remainingFraction: 0.6, resetTime: reset1 } },
    'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', quotaInfo: { remainingFraction: 0.95, resetTime: reset2 } },
    'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', quotaInfo: { remainingFraction: 0.95, resetTime: reset2 } },
    tab_flash_lite_preview: { quotaInfo: { remainingFraction: 0 } },
    'gemini-4-hydrogen-sonar': { quotaInfo: { remainingFraction: 0.1, resetTime: reset1 } }
  }
}

test('antigravity: modelos que dividem a cota viram uma linha so', () => {
  const vm = toAntigravityViewModel(agModels, NOW)
  assert.deepEqual(vm.windows.map(w => [w.name, w.pct]), [['Claude · GPT-OSS · 5 h', 5], ['Gemini · 5 h', 40]])
})

test('antigravity: resumo por grupo traz semana e 5 h, e tira essas familias da cota por modelo', () => {
  const raw = {
    ...agModels,
    groups: [{
      displayName: 'Claude and GPT models',
      buckets: [
        { window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-26T12:46:58Z' },
        { window: '5h', remainingFraction: 0.7, resetTime: '2026-11-19T07:46:58Z' }
      ]
    }]
  }
  const vm = toAntigravityViewModel(raw, NOW)
  assert.deepEqual(vm.windows.map(w => [w.name, w.pct]), [
    ['Claude · GPT · 5 h', 30],
    ['Claude · GPT · semana', 10],
    ['Gemini · 5 h', 40]
  ])
  assert.equal(vm.session.label, 'Gemini · 5 h')
})

test('antigravity: mostrador e a cota mais gasta, com contagem ate o reset', () => {
  const vm = toAntigravityViewModel(agModels, NOW)
  assert.equal(vm.session.pct, 40)
  assert.equal(vm.session.label, 'Gemini · 5 h')
  assert.equal(vm.session.countdown, '4 h 50')
})

test('antigravity: modelos internos sem displayName ficam de fora', () => {
  const vm = toAntigravityViewModel(agModels, NOW)
  assert.ok(!vm.windows.some(w => w.pct === 100 || w.pct === 90))
})

test('antigravity: plano sai do tier, sem o sufixo', () => {
  assert.equal(antigravityPlan(agModels), 'free')
  assert.equal(antigravityPlan({}), null)
})

test('antigravity: credencial do keyring le token e validade', () => {
  const blob = JSON.stringify({ token: { access_token: 'ya29.x', expiry: '2026-11-19T01:58:22.877118-03:00' }, id_token_email: 'a@b.c' })
  const c = parseAntigravity(blob, Date.parse('2026-11-19T04:00:00Z'))
  assert.equal(c.token, 'ya29.x')
  assert.equal(c.expired, false)
  assert.equal(parseAntigravity(blob, Date.parse('2026-11-19T05:00:00Z')).expired, true)
})

test('antigravity: credencial sem token vira erro nomeado', () => {
  assert.throws(() => parseAntigravity('{"token":{}}'), err => err.code === 'BAD_SHAPE')
  assert.throws(() => parseAntigravity('nao-json'), err => err.code === 'BAD_JSON')
})

// ---------------------------------------------------------------- Qwen

const qwen = require('../lib/qwen-usage')
const { toQwenViewModel } = require('../lib/qwen-view-model')

const apiLine = (ts, auth = 'openai') => JSON.stringify({
  type: 'system',
  subtype: 'ui_telemetry',
  timestamp: ts,
  systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_response', 'event.timestamp': ts, auth_type: auth, model: 'qwen3.5-plus', status_code: 200 } }
})

test('qwen: so eventos de resposta da API contam como requisicao', () => {
  const ts = '2026-11-19T04:00:00.000Z'
  assert.equal(qwen.requestAt(apiLine(ts)), Date.parse(ts))
  assert.equal(qwen.requestAt(apiLine(ts, 'qwen-oauth')), null, 'login gratuito nao gasta o Coding Plan')
  assert.equal(qwen.requestAt('{"type":"assistant"}'), null)
  assert.equal(qwen.requestAt('lixo qwen-code.api_response'), null)
})

test('qwen: detecta Coding Plan pela configuracao ou pela URL do provedor', () => {
  assert.equal(qwen.usesCodingPlan({ codingPlan: { region: 'global' } }), true)
  assert.equal(qwen.usesCodingPlan({ modelProviders: { openai: [{ baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1' }] } }), true)
  assert.equal(qwen.usesCodingPlan({ security: { auth: { selectedType: 'qwen-oauth' } } }), false)
})

test('qwen: janelas moveis de 5 h, 7 e 30 dias contra o limite do plano', () => {
  const H = 3600_000
  const requests = [
    ...Array(600).fill(NOW - 1 * H), // dentro das 5 h
    ...Array(300).fill(NOW - 3 * 86400_000), // dentro da semana
    ...Array(900).fill(NOW - 20 * 86400_000) // so no mes
  ]
  const vm = toQwenViewModel({ tier: 'lite', requests }, NOW)
  assert.equal(vm.session.pct, 50) // 600 / 1200
  assert.equal(vm.session.countdown, '4 h 00') // a mais antiga sai da janela em 4 h
  assert.deepEqual(vm.windows.map(w => [w.name, w.pct]), [['7 dias', 10], ['30 dias', 10]]) // 900/9000, 1800/18000
  assert.equal(vm.estimate, true)
})

test('qwen: sem requisicoes, janela livre e nada de erro', () => {
  const vm = toQwenViewModel({ tier: 'pro', requests: [] }, NOW)
  assert.equal(vm.session.pct, 0)
  assert.equal(vm.session.countdown, 'livre')
})

test('qwen: le os transcripts de uma pasta como a ~/.qwen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-'))
  const chats = path.join(dir, 'projects', 'proj', 'chats')
  fs.mkdirSync(chats, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ codingPlan: { region: 'global' } }))
  const now = Date.now()
  fs.writeFileSync(path.join(chats, 's.jsonl'), [
    apiLine(new Date(now - 60_000).toISOString()),
    apiLine(new Date(now - 120_000).toISOString()),
    apiLine(new Date(now - 40 * 86400_000).toISOString()), // fora do mes
    '{"type":"user"}'
  ].join('\n'))
  const raw = await qwen.fetchQwenUsage({ dir, tier: 'pro', now })
  assert.equal(raw.requests.length, 2)
  assert.equal(raw.tier, 'pro')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('qwen: pasta sem Coding Plan conta como ferramenta ausente', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-'))
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}')
  await assert.rejects(qwen.fetchQwenUsage({ dir }), err => err.code === 'NO_FILE')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- registro

const { PROVIDERS, classify } = require('../lib/providers')
const { CredsError } = require('../lib/creds')
const { UsageError } = require('../lib/usage')

test('registro: oito fontes, cada uma com cache proprio e logo no disco', () => {
  assert.deepEqual(PROVIDERS.map(p => p.id), ['claude', 'codex', 'kimi', 'grok', 'antigravity', 'zcode', 'opencode', 'qwen'])
  assert.equal(new Set(PROVIDERS.map(p => p.cacheFile)).size, PROVIDERS.length)
  for (const p of PROVIDERS) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'logos', `${p.id}.svg`)), p.id)
  }
})

test('registro: erros viram os estados que a tela entende', () => {
  assert.equal(classify(new CredsError('NO_FILE', 'x')).status, 'missing')
  assert.equal(classify(new CredsError('BAD_JSON', 'x')).status, 'error')
  assert.equal(classify(new UsageError('TOKEN_EXPIRED', 'x')).status, 'expired')
  assert.equal(classify(new UsageError('TIMEOUT', 'x')).status, 'offline')
  assert.equal(classify(new UsageError('HTTP_ERROR', 'boom')).message, 'boom')
})

// ---------------------------------------------------------------- QwenCloud Token Plan

const qc = require('../lib/qwencloud')

// innerText real do painel de uso, valores da conta substituidos por exemplo.
const panel = 'Token Plan Usage\nIndividual\nTeam\nIndividual Plan\nStandard\nLast updated 2026-11-19 02:45:33\nStatus\nActive\nRemaining days\n11 days\nExpiry date\n2026-11-30 13:00:00\nAuto-renew\nMonthly Quota\nReset time 2026-11-30 13:00:00\nRemaining\n78.2%\nPlan quota\n80,000\nUpgrade\nRenew\nCredit Pack'

test('qwencloud: le plano, restante, cota e reinicio do texto do painel', () => {
  const r = qc.parseUsageText(panel)
  assert.equal(r.plan, 'standard')
  assert.equal(r.status, 'Active')
  assert.equal(r.remainingPct, 78.2)
  assert.equal(r.quota, 80000)
  assert.equal(r.resetsAt, new Date(2026, 10, 30, 13, 0, 0).getTime())
})

test('qwencloud: pagina de login ou carregando nao vira numero', () => {
  assert.equal(qc.parseUsageText('Sign in to QwenCloud'), null)
  assert.equal(qc.parseUsageText(''), null)
  assert.equal(qc.parseUsageText(null), null)
  assert.equal(qc.isLoggedOut('Log in to QwenCloud. You are currently not logged in.'), true)
  assert.equal(qc.isLoggedOut(panel), false)
})

test('qwencloud: tela mostra o gasto do mes e os Credits usados', () => {
  const now = new Date(2026, 10, 19, 3, 0).getTime()
  const vm = qc.toQwenCloudViewModel(qc.parseUsageText(panel), now)
  assert.equal(vm.session, null)
  assert.equal(vm.windows[0].name, 'Mês')
  assert.equal(vm.windows[0].pct, 22)
  assert.equal(vm.windows[1].when, '17.440 / 80.000')
})

test('qwen: com a QwenCloud conectada, le o Token Plan em vez do disco', async () => {
  const p = PROVIDERS.find(x => x.id === 'qwen')
  const out = await p.load({ qwenCloud: async () => qc.parseUsageText(panel) })
  assert.equal(out.plan, 'standard')
  assert.equal(p.toVM(out.raw, Date.now()).windows[0].name, 'Mês')
})

// ---------------------------------------------------------------- OpenCode Go

const oc = require('../lib/opencode')

// Estrutura real de /zen/go/v1/usage, valores de exemplo.
const goUsage = {
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-11-19T07:16:31.000Z' },
    weekly: { status: 'ok', percent: 10, resetsAt: '2026-11-23T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 5, resetsAt: '2026-12-09T16:41:43.000Z' }
  }
}

test('opencode: janela de 5 h vira o mostrador; semana e mes viram linhas', () => {
  const vm = oc.toOpencodeViewModel(goUsage, NOW)
  assert.equal(vm.session.pct, 1)
  assert.equal(vm.session.label, '5 h')
  assert.equal(vm.session.countdown, '2 h 46')
  assert.deepEqual(vm.windows.map(w => [w.name, w.pct]), [['Semana', 10], ['Mês', 5]])
})

test('opencode: janela bloqueada fica vermelha mesmo com percentual baixo', () => {
  const raw = structuredClone(goUsage)
  raw.usage.weekly.status = 'limited'
  assert.equal(oc.toOpencodeViewModel(raw, NOW).windows[0].severity, 'crit')
})

test('opencode: resposta vazia ou estranha nao derruba a conversao', () => {
  for (const raw of [null, {}, { usage: 'x' }, { usage: { rolling: { percent: 'x' } } }]) {
    assert.deepEqual(oc.toOpencodeViewModel(raw, NOW).windows, [])
  }
})

test('opencode: le a chave do Go no auth.json e ignora os outros provedores', () => {
  const text = JSON.stringify({ openrouter: { type: 'api', key: 'a' }, 'opencode-go': { type: 'api', key: 'go-key' } })
  assert.equal(oc.parseAuth(text).token, 'go-key')
  assert.throws(() => oc.parseAuth('{"openrouter":{"key":"a"}}'), err => err.code === 'NO_FILE')
  assert.throws(() => oc.parseAuth('nao-json'), err => err.code === 'BAD_JSON')
})
