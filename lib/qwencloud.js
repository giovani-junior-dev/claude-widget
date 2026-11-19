'use strict'

// Token Plan da QwenCloud (assinatura em Credits, cota mensal). Nao ha API
// publica de uso: a documentacao manda olhar o console. O widget abre a pagina
// de uso numa janela invisivel, com a sessao que o usuario fez uma vez na janela
// de login do proprio widget, e le o texto que o painel mostra.

const { pctOf, severityFromPct, toDate, whenLabel, countdown } = require('./view-model')

const USAGE_URL = 'https://home.qwencloud.com/analytics/token-plan/individual?region=ap-southeast-1'
const intFmt = new Intl.NumberFormat('pt-BR')

// "2026-11-30 13:00:00" no fuso de quem ve a pagina (o console formata no local).
function localDate (s) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '')
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime()
}

// Valor da linha seguinte ao rotulo, no innerText do painel.
function after (lines, label) {
  const i = lines.findIndex(l => l === label)
  return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null
}

// Texto do painel -> numeros. Devolve null se a pagina nao for o painel de uso
// (login, carregando, layout novo): quem chama trata como "sem dado".
function parseUsageText (text) {
  if (typeof text !== 'string' || !text.includes('Plan quota')) return null
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const start = lines.findIndex(l => l === 'Individual Plan')
  const body = start >= 0 ? lines.slice(start) : lines

  const remaining = parseFloat(String(after(body, 'Remaining') || '').replace(',', '.'))
  const quota = parseInt(String(after(body, 'Plan quota') || '').replace(/[^\d]/g, ''), 10)
  const resetLine = body.find(l => /^Reset time /.test(l))
  if (!Number.isFinite(remaining) || !Number.isFinite(quota)) return null

  return {
    plan: start >= 0 && body[1] && !/^Last updated/.test(body[1]) ? body[1].toLowerCase() : null,
    status: after(body, 'Status'),
    remainingPct: remaining,
    quota,
    resetsAt: resetLine ? localDate(resetLine.slice('Reset time '.length)) : null
  }
}

// Sem sessao o console nao redireciona: mostra um aviso no lugar do painel.
function isLoggedOut (text) {
  return typeof text === 'string' && /currently not logged in|Log in to QwenCloud/i.test(text)
}

function toQwenCloudViewModel (raw, now = Date.now()) {
  if (!raw || typeof raw.remainingPct !== 'number') return { session: null, windows: [], spend: null, at: now }
  const pct = pctOf(100 - raw.remainingPct)
  const used = Math.round(raw.quota * (100 - raw.remainingPct) / 100)
  const resetsAt = toDate(raw.resetsAt)
  return {
    session: null,
    windows: [
      { name: 'Mês', pct, when: whenLabel(resetsAt, now), severity: severityFromPct(pct) },
      { name: 'Credits', pct, when: `${intFmt.format(used)} / ${intFmt.format(raw.quota)}`, severity: severityFromPct(pct) }
    ],
    spend: null,
    resetCountdown: countdown(resetsAt, now),
    at: now
  }
}

module.exports = { parseUsageText, isLoggedOut, toQwenCloudViewModel, localDate, USAGE_URL }
