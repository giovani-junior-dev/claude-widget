'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { toViewModel, worstSeverity } = require('../lib/view-model')
const { parse, CredsError } = require('../lib/creds')

const load = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'))
// Fixture com a estrutura real da resposta da API, valores substituidos por exemplo.
const real = load('fixture-usage.json')
const empty = load('fixture-empty.json')

// Instante de referencia das fixtures, para o teste nao depender da hora real.
const NOW = Date.parse('2026-07-28T17:57:00.000Z')

// Intl usa espaco nao-separavel entre simbolo e numero.
const flat = s => (s == null ? s : s.replace(/ /g, ' '))

test('resposta de exemplo:sessao de 5 h', () => {
  const vm = toViewModel(real, NOW)
  assert.equal(vm.session.pct, 43)
  assert.equal(vm.session.countdown, '23 min')
  assert.equal(vm.session.severity, 'ok')
})

test('reset ainda hoje diz "hoje"', () => {
  const vm = toViewModel(real, NOW)
  assert.match(vm.session.at, /^hoje, /)
})

test('reset depois da meia-noite diz "amanha", nao "hoje"', () => {
  const late = structuredClone(real)
  // Reinicio as 01:19 do dia seguinte, visto de 22:52 do dia anterior.
  late.five_hour.resets_at = '2026-07-29T04:19:00+00:00'
  late.limits[0].resets_at = late.five_hour.resets_at
  const vm = toViewModel(late, Date.parse('2026-07-29T01:52:00.000Z'))
  assert.match(vm.session.at, /^amanhã, /)
  assert.equal(vm.session.countdown, '2 h 27')
})

test('resposta de exemplo:uma linha por janela semanal, nomeada pelo modelo', () => {
  const vm = toViewModel(real, NOW)
  assert.equal(vm.windows.length, 2)
  assert.equal(vm.windows[0].name, 'Semana toda')
  assert.equal(vm.windows[0].pct, 28)
  assert.equal(vm.windows[1].name, 'Fable · semanal')
  assert.equal(vm.windows[1].pct, 4)
})

test('creditos formatados a partir de amount_minor', () => {
  const vm = toViewModel(real, NOW)
  assert.equal(flat(vm.spend.used), 'R$ 12,34')
  assert.equal(flat(vm.spend.limit), 'R$ 100,00')
  assert.equal(vm.spend.pct, 12)
})

test('fixture vazia produz null sem lancar', () => {
  const vm = toViewModel(empty, NOW)
  assert.equal(vm.session, null)
  assert.deepEqual(vm.windows, [])
  assert.equal(vm.spend, null)
})

test('entrada invalida nao derruba a conversao', () => {
  for (const bad of [null, undefined, 42, 'texto', []]) {
    const vm = toViewModel(bad, NOW)
    assert.equal(vm.session, null)
    assert.deepEqual(vm.windows, [])
  }
})

test('resets_at no passado vira "reinicia agora", nunca tempo negativo', () => {
  const vm = toViewModel(real, Date.parse('2026-07-29T00:00:00.000Z'))
  assert.equal(vm.session.countdown, 'reinicia agora')
})

test('mais de uma hora restante sai como "N h MM"', () => {
  const vm = toViewModel(real, Date.parse('2026-07-28T16:10:00.000Z'))
  assert.equal(vm.session.countdown, '2 h 10')
})

test('mais de 24 h restantes sai como data curta', () => {
  const vm = toViewModel(real, Date.parse('2026-07-25T12:00:00.000Z'))
  assert.match(vm.session.countdown, /\d{2}\/\d{2}/)
})

test('moeda vem do payload, nao fixada em BRL', () => {
  const usd = structuredClone(real)
  usd.spend.used = { amount_minor: 1234, currency: 'USD', exponent: 2 }
  usd.spend.limit = { amount_minor: 10000, currency: 'USD', exponent: 2 }
  const vm = toViewModel(usd, NOW)
  assert.match(flat(vm.spend.used), /12,34/)
  assert.match(flat(vm.spend.used), /US\$|\$/)
})

test('expoente diferente de 2 e respeitado', () => {
  const jpy = structuredClone(real)
  jpy.spend.used = { amount_minor: 1500, currency: 'JPY', exponent: 0 }
  jpy.spend.limit = { amount_minor: 30000, currency: 'JPY', exponent: 0 }
  const vm = toViewModel(jpy, NOW)
  assert.match(flat(vm.spend.used), /1\.500/)
})

test('severidade desconhecida nao vira alarme falso', () => {
  const odd = structuredClone(real)
  odd.limits[0].severity = 'algo_novo'
  const vm = toViewModel(odd, NOW)
  assert.equal(vm.session.severity, 'ok')
})

test('severidade critica em qualquer medidor domina o icone da bandeja', () => {
  const hot = structuredClone(real)
  hot.limits[1].severity = 'critical'
  hot.limits[0].severity = 'warning'
  assert.equal(worstSeverity(toViewModel(hot, NOW)), 'crit')
})

test('sessao cai para limits[] quando five_hour nao vem', () => {
  const noWindow = structuredClone(real)
  noWindow.five_hour = null
  const vm = toViewModel(noWindow, NOW)
  assert.equal(vm.session.pct, 43)
  assert.equal(vm.session.countdown, '23 min')
})

test('semana cai para seven_day quando limits[] nao traz o grupo weekly', () => {
  const noLimits = structuredClone(real)
  noLimits.limits = [noLimits.limits[0]]
  const vm = toViewModel(noLimits, NOW)
  assert.equal(vm.windows.length, 1)
  assert.equal(vm.windows[0].pct, 28)
})

test('spend desligado some da tela sem quebrar o resto', () => {
  const off = structuredClone(real)
  off.spend = null
  const vm = toViewModel(off, NOW)
  assert.equal(vm.spend, null)
  assert.equal(vm.session.pct, 43)
})

test('percentual fora da faixa e limitado a 0..100', () => {
  const weird = structuredClone(real)
  weird.five_hour.utilization = 143.7
  assert.equal(toViewModel(weird, NOW).session.pct, 100)
  weird.five_hour.utilization = -5
  assert.equal(toViewModel(weird, NOW).session.pct, 0)
})

// --- tokens por modelo ---

test('so os dias dentro da janela de 7 dias entram na conta', () => {
  const { windowDays, dayKey } = require('../lib/token-usage')
  const dias = windowDays(NOW)
  assert.equal(dias.size, 7)
  assert.ok(dias.has(dayKey(NOW)), 'hoje entra')
  assert.ok(dias.has(dayKey(NOW - 6 * 86400_000)), 'seis dias atras entra')
  assert.ok(!dias.has(dayKey(NOW - 7 * 86400_000)), 'sete dias atras fica de fora')
})

test('cada periodo do seletor cobre exatamente os seus dias', () => {
  const { windowDays, dayKey, WINDOW_CHOICES } = require('../lib/token-usage')
  assert.deepEqual(WINDOW_CHOICES, [7, 30, 90])
  for (const days of WINDOW_CHOICES) {
    const dias = windowDays(NOW, days)
    assert.equal(dias.size, days, `${days} dias`)
    assert.ok(dias.has(dayKey(NOW - (days - 1) * 86400_000)), 'o dia mais antigo entra')
    assert.ok(!dias.has(dayKey(NOW - days * 86400_000)), 'o dia seguinte ao limite fica de fora')
  }
})

test('janela maior contem a menor, nunca o contrario', () => {
  const { windowDays } = require('../lib/token-usage')
  const d7 = windowDays(NOW, 7)
  const d30 = windowDays(NOW, 30)
  for (const d of d7) assert.ok(d30.has(d), `${d} deveria estar tambem em 30 dias`)
  assert.ok(d30.size > d7.size)
})

test('mergeDays soma o trecho novo sem perder o que ja estava contado', () => {
  const { mergeDays } = require('../lib/token-usage')
  const base = { '2026-07-28': { 'claude-opus-5': { output: 10, input: 1, cacheRead: 2, cacheWrite: 3, calls: 1 } } }
  mergeDays(base, {
    '2026-07-28': { 'claude-opus-5': { output: 5, input: 1, cacheRead: 0, cacheWrite: 0, calls: 1 } },
    '2026-07-29': { 'glm-5': { output: 7, input: 2, cacheRead: 0, cacheWrite: 0, calls: 2 } }
  })
  assert.equal(base['2026-07-28']['claude-opus-5'].output, 15)
  assert.equal(base['2026-07-28']['claude-opus-5'].calls, 2)
  assert.equal(base['2026-07-29']['glm-5'].output, 7)
})

test('le tokens de um transcript real, ignora <synthetic> e linhas sem uso', async () => {
  const { scanFile } = require('../lib/token-usage')
  const tmp = path.join(os.tmpdir(), `widget-scan-${process.pid}.jsonl`)
  const linha = (model, output, ts) => JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { model, usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } }
  })
  fs.writeFileSync(tmp, [
    linha('claude-opus-5', 400, '2026-07-28T17:54:48.816Z'),
    linha('claude-opus-5', 100, '2026-07-28T18:00:00.000Z'),
    linha('glm-5', 50, '2026-07-28T18:10:00.000Z'),
    linha('<synthetic>', 999, '2026-07-28T18:20:00.000Z'),
    JSON.stringify({ type: 'user', timestamp: '2026-07-28T18:30:00.000Z', message: { content: 'oi' } }),
    'linha quebrada { nao e json'
  ].join('\n') + '\n')

  const days = await scanFile(tmp, 0)
  const dia = days[Object.keys(days)[0]]
  assert.equal(dia['claude-opus-5'].output, 500)
  assert.equal(dia['claude-opus-5'].calls, 2)
  assert.equal(dia['claude-opus-5'].cacheRead, 200)
  assert.equal(dia['glm-5'].output, 50)
  assert.ok(!dia['<synthetic>'], 'mensagem sintetica nao conta como consumo')
  fs.unlinkSync(tmp)
})

test('nomes que nunca foram modelo de verdade ficam de fora', () => {
  const { isRealModel } = require('../lib/token-usage')
  for (const bom of ['claude-opus-5', 'glm-4.7', 'MiniMax-M2.5', 'deepseek-reasoner', 'kimi-k2-thinking-turbo']) {
    assert.ok(isRealModel(bom), `${bom} deveria contar`)
  }
  for (const ruim of ['<synthetic>', '$ANTHROPIC_MODEL', '"k3"', '', "'x'"]) {
    assert.ok(!isRealModel(ruim), `${ruim} nao deveria contar`)
  }
})

test('leitura a partir de um deslocamento pega so o trecho novo', async () => {
  const { scanFile } = require('../lib/token-usage')
  const tmp = path.join(os.tmpdir(), `widget-offset-${process.pid}.jsonl`)
  const linha = (output) => JSON.stringify({
    type: 'assistant', timestamp: '2026-07-28T18:00:00.000Z',
    message: { model: 'claude-opus-5', usage: { output_tokens: output } }
  }) + '\n'
  const primeira = linha(400)
  fs.writeFileSync(tmp, primeira)
  const antes = fs.statSync(tmp).size
  fs.appendFileSync(tmp, linha(60))

  const days = await scanFile(tmp, antes)
  const dia = days[Object.keys(days)[0]]
  assert.equal(dia['claude-opus-5'].output, 60, 'nao recontou a linha antiga')
  assert.equal(dia['claude-opus-5'].calls, 1)
  fs.unlinkSync(tmp)
})

// --- ritmo das consultas ---

test('falha dobra a espera, sucesso devolve ao ritmo normal', () => {
  const { nextBackoff, BASE_MS, MAX_MS } = require('../lib/poll-policy')
  let b = BASE_MS
  b = nextBackoff(b, false); assert.equal(b, BASE_MS * 2)
  b = nextBackoff(b, false); assert.equal(b, BASE_MS * 4)
  b = nextBackoff(b, true); assert.equal(b, BASE_MS)
})

test('a espera nunca passa do teto, por mais falhas que venham', () => {
  const { nextBackoff, MAX_MS } = require('../lib/poll-policy')
  let b = 0
  for (let i = 0; i < 50; i++) b = nextBackoff(b, false)
  assert.equal(b, MAX_MS)
})

// --- credenciais ---

test('credencial valida e lida sem expor o token na mensagem de erro', () => {
  const c = parse(JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-abc', expiresAt: NOW + 3600_000, subscriptionType: 'max' }
  }), NOW)
  assert.equal(c.token, 'sk-abc')
  assert.equal(c.plan, 'max')
  assert.equal(c.expired, false)
})

test('credencial vencida e marcada antes de gastar a requisicao', () => {
  const c = parse(JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-abc', expiresAt: NOW + 30_000 }
  }), NOW)
  assert.equal(c.expired, true)
})

test('arquivo gravado com BOM ainda e lido', () => {
  const body = JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-abc', expiresAt: NOW + 3600_000 }
  })
  const c = parse('﻿' + body, NOW)
  assert.equal(c.token, 'sk-abc')
})

test('formato inesperado vira erro nomeado, sem vazar conteudo', () => {
  assert.throws(() => parse('{"nada": 1}', NOW), err => {
    assert.ok(err instanceof CredsError)
    assert.equal(err.code, 'BAD_SHAPE')
    return true
  })
  assert.throws(() => parse('nao e json', NOW), err => err.code === 'BAD_JSON')
})

// --- codex ---

const { toCodexViewModel } = require('../lib/codex-view-model')
const { parse: parseCodex } = require('../lib/codex-creds')

const codexFixture = load('fixture-codex-usage.json')
// Instante que a propria resposta implica: reset_at - reset_after_seconds da janela curta.
const CODEX_NOW = (codexFixture.rate_limit.secondary_window.reset_at -
  codexFixture.rate_limit.secondary_window.reset_after_seconds) * 1000

function fakeJwt (payload) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.assinatura-fake`
}

test('codex: janela curta vira o mostrador, semanal vira linha', () => {
  const vm = toCodexViewModel(codexFixture, CODEX_NOW)
  assert.equal(vm.session.pct, 43)
  assert.equal(vm.session.countdown, '23 min')
  assert.equal(vm.windows.length, 1)
  assert.equal(vm.windows[0].name, 'Semana')
  assert.equal(vm.windows[0].pct, 11)
})

test('codex: sem janela curta, mostrador fica vazio mas a semana continua', () => {
  const semCurta = structuredClone(codexFixture)
  semCurta.rate_limit.secondary_window = null
  const vm = toCodexViewModel(semCurta, CODEX_NOW)
  assert.equal(vm.session, null)
  assert.equal(vm.windows.length, 1)
  assert.equal(vm.windows[0].pct, 11)
})

test('codex: resposta sem rate_limit nao derruba a conversao', () => {
  for (const bad of [null, undefined, {}, { rate_limit: null }]) {
    const vm = toCodexViewModel(bad, CODEX_NOW)
    assert.equal(vm.session, null)
    assert.deepEqual(vm.windows, [])
    assert.equal(vm.spend, null)
  }
})

test('codex: cortes de severidade sem campo pronto na API', () => {
  const quente = structuredClone(codexFixture)
  quente.rate_limit.secondary_window.used_percent = 95
  assert.equal(toCodexViewModel(quente, CODEX_NOW).session.severity, 'crit')

  quente.rate_limit.secondary_window.used_percent = 80
  assert.equal(toCodexViewModel(quente, CODEX_NOW).session.severity, 'warn')

  quente.rate_limit.secondary_window.used_percent = 50
  assert.equal(toCodexViewModel(quente, CODEX_NOW).session.severity, 'ok')
})

test('codex: credencial valida le token, plano e validade de dentro do JWT', () => {
  const jwt = fakeJwt({
    exp: Math.floor(NOW / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }
  })
  const c = parseCodex(JSON.stringify({ tokens: { access_token: jwt } }), NOW)
  assert.equal(c.token, jwt)
  assert.equal(c.plan, 'plus')
  assert.equal(c.expired, false)
})

test('codex: credencial vencida e marcada antes de gastar a requisicao', () => {
  const jwt = fakeJwt({ exp: Math.floor(NOW / 1000) + 30 })
  const c = parseCodex(JSON.stringify({ tokens: { access_token: jwt } }), NOW)
  assert.equal(c.expired, true)
})

test('codex: formato inesperado vira erro nomeado, sem vazar conteudo', () => {
  assert.throws(() => parseCodex('{"nada": 1}', NOW), err => {
    assert.ok(err instanceof CredsError)
    assert.equal(err.code, 'BAD_SHAPE')
    return true
  })
  assert.throws(() => parseCodex('nao e json', NOW), err => err.code === 'BAD_JSON')
})

// --- kimi ---

const { toKimiViewModel } = require('../lib/kimi-view-model')
const { parse: parseKimi } = require('../lib/kimi-creds')

const kimiFixture = load('fixture-kimi-usage.json')
const KIMI_NOW = Date.parse('2026-08-07T06:00:00.000Z')

test('kimi: janela mais curta dos limits[] vira o mostrador, resumo semanal vira linha', () => {
  const vm = toKimiViewModel(kimiFixture, KIMI_NOW)
  assert.equal(vm.session.pct, 9)
  assert.equal(vm.windows.length, 1)
  assert.equal(vm.windows[0].name, 'Semana')
  assert.equal(vm.windows[0].pct, 21)
})

test('kimi: sem limits[], mostrador fica vazio mas o resumo semanal continua', () => {
  const semLimits = structuredClone(kimiFixture)
  semLimits.limits = []
  const vm = toKimiViewModel(semLimits, KIMI_NOW)
  assert.equal(vm.session, null)
  assert.equal(vm.windows.length, 1)
})

test('kimi: resposta invalida nao derruba a conversao', () => {
  for (const bad of [null, undefined, 42, {}, { usage: null, limits: null }]) {
    const vm = toKimiViewModel(bad, KIMI_NOW)
    assert.equal(vm.session, null)
    assert.deepEqual(vm.windows, [])
    assert.equal(vm.spend, null)
  }
})

test('kimi: limite zerado nao vira divisao por zero', () => {
  const zerado = structuredClone(kimiFixture)
  zerado.usage.limit = '0'
  const vm = toKimiViewModel(zerado, KIMI_NOW)
  assert.deepEqual(vm.windows, [])
})

test('kimi: credencial valida le tokens e validade em segundos', () => {
  const c = parseKimi(JSON.stringify({
    access_token: 'acc-abc',
    refresh_token: 'ref-abc',
    expires_at: Math.floor(NOW / 1000) + 900
  }), NOW)
  assert.equal(c.accessToken, 'acc-abc')
  assert.equal(c.refreshToken, 'ref-abc')
  assert.equal(c.expired, false)
})

test('kimi: token de 15 min ja e tratado como vencido perto do limite', () => {
  const c = parseKimi(JSON.stringify({
    access_token: 'acc-abc',
    refresh_token: 'ref-abc',
    expires_at: Math.floor(NOW / 1000) + 10
  }), NOW)
  assert.equal(c.expired, true)
})

test('kimi: formato inesperado vira erro nomeado, sem vazar conteudo', () => {
  assert.throws(() => parseKimi('{"nada": 1}', NOW), err => {
    assert.ok(err instanceof CredsError)
    assert.equal(err.code, 'BAD_SHAPE')
    return true
  })
  assert.throws(() => parseKimi('nao e json', NOW), err => err.code === 'BAD_JSON')
})
