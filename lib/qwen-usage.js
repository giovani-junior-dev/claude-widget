'use strict'

// Qwen Code com o Coding Plan do Alibaba Model Studio. Nao ha endpoint publico
// que devolva a cota com a chave de API, entao o consumo e contado no historico
// local: cada requisicao ao modelo grava um evento "qwen-code.api_response" no
// transcript de ~/.qwen/projects/*/chats/*.jsonl. O limite do plano conta
// requisicoes, entao e isso que se soma — em janelas moveis de 5 h, 7 e 30 dias.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CredsError } = require('./creds')

const QWEN_DIR = process.env.CLAUDE_WIDGET_QWEN_DIR || path.join(os.homedir(), '.qwen')

const HOUR = 3600_000
const DAY = 24 * HOUR
const WINDOWS = { session: 5 * HOUR, week: 7 * DAY, month: 30 * DAY }

// Limites publicados do Coding Plan (requisicoes por janela).
const TIERS = {
  lite: { label: 'lite', session: 1200, week: 9000, month: 18000 },
  pro: { label: 'pro', session: 6000, week: 45000, month: 90000 }
}

function readSettings (dir = QWEN_DIR) {
  let text
  try {
    text = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw new CredsError('NO_FILE', 'Qwen Code não encontrado nesta máquina.')
    throw new CredsError('UNREADABLE', 'Não foi possível ler as configurações do Qwen Code.')
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new CredsError('BAD_JSON', 'As configurações do Qwen Code não são um JSON válido.')
  }
}

function usesCodingPlan (settings) {
  if (settings && settings.codingPlan) return true
  const providers = settings && settings.modelProviders
  return !!providers && Object.values(providers).flat().some(p => p && /coding(-intl)?\.dashscope/.test(p.baseUrl || ''))
}

// Uma linha do transcript -> instante da requisicao, ou null se nao for uma.
function requestAt (line) {
  if (!line.includes('qwen-code.api_response')) return null
  let o
  try { o = JSON.parse(line) } catch { return null }
  const ev = o && o.systemPayload && o.systemPayload.uiEvent
  if (!ev || ev['event.name'] !== 'qwen-code.api_response') return null
  // Login gratuito da Qwen (qwen-oauth) nao gasta a cota do Coding Plan.
  if (ev.auth_type === 'qwen-oauth') return null
  const t = Date.parse(ev['event.timestamp'] || o.timestamp)
  return Number.isFinite(t) ? t : null
}

function chatFiles (dir, since) {
  const out = []
  let projects = []
  try { projects = fs.readdirSync(path.join(dir, 'projects')) } catch { return out }
  for (const p of projects) {
    const chats = path.join(dir, 'projects', p, 'chats')
    let names = []
    try { names = fs.readdirSync(chats) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const f = path.join(chats, n)
      try {
        // Transcript sem escrita na janela do mes nao tem nada a somar.
        if (fs.statSync(f).mtimeMs >= since) out.push(f)
      } catch { /* sumiu entre o readdir e o stat */ }
    }
  }
  return out
}

async function collectRequests (dir, now) {
  const since = now - WINDOWS.month
  const times = []
  for (const f of chatFiles(dir, since)) {
    let text
    try { text = await fs.promises.readFile(f, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const t = requestAt(line)
      if (t != null && t >= since && t <= now) times.push(t)
    }
  }
  return times.sort((a, b) => a - b)
}

function tierOf (name) {
  const key = String(name || process.env.CLAUDE_WIDGET_QWEN_TIER || 'lite').toLowerCase()
  return TIERS[key] || TIERS.lite
}

// Mesmo contrato dos outros provedores: devolve o "bruto" que o view-model converte.
async function fetchQwenUsage ({ dir = QWEN_DIR, tier, now = Date.now() } = {}) {
  const settings = readSettings(dir)
  if (!usesCodingPlan(settings)) {
    throw new CredsError('NO_FILE', 'Qwen Code sem Coding Plan configurado.')
  }
  return { tier: tierOf(tier).label, requests: await collectRequests(dir, now), countedAt: now }
}

module.exports = { fetchQwenUsage, collectRequests, requestAt, usesCodingPlan, tierOf, TIERS, WINDOWS, QWEN_DIR }
