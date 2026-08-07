'use strict'

// Converte /coding/v1/usages (packages/oauth/src/managed-usage.ts do
// MoonshotAI/kimi-code) no mesmo formato de tela que Claude e Codex usam.

const { toDate, whenLabel, dayWord, pctOf, countdown } = require('./view-model')

const clockFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

const UNIT_SECONDS = { TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86400, TIME_UNIT_WEEK: 604800 }

// A API do Kimi tambem nao manda severidade pronta: mesmos cortes do resto do widget.
function severityFromPct (pct) {
  if (pct >= 90) return 'crit'
  if (pct >= 75) return 'warn'
  return 'ok'
}

function toNumber (v) {
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? n : null
}

function rowFrom (used, limit, resetTime) {
  const u = toNumber(used)
  const l = toNumber(limit)
  if (u == null || l == null || l <= 0) return null
  const pct = pctOf((u / l) * 100)
  if (pct == null) return null
  return { pct, resetsAt: toDate(resetTime), severity: severityFromPct(pct) }
}

function windowSeconds (window) {
  if (!window || typeof window.duration !== 'number') return Infinity
  return window.duration * (UNIT_SECONDS[window.timeUnit] || 0)
}

function toKimiViewModel (raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return { session: null, windows: [], spend: null, at: now }

  const weekly = raw.usage ? rowFrom(raw.usage.used, raw.usage.limit, raw.usage.resetTime) : null

  const limits = Array.isArray(raw.limits) ? raw.limits.filter(l => l && l.detail) : []
  const shortest = limits.length
    ? limits.reduce((a, b) => (windowSeconds(a.window) <= windowSeconds(b.window) ? a : b))
    : null
  // So vira "sessao" se for de fato mais curta que a semanal: evita duplicar a mesma janela.
  const session = shortest && windowSeconds(shortest.window) < UNIT_SECONDS.TIME_UNIT_WEEK
    ? rowFrom(shortest.detail.used, shortest.detail.limit, shortest.detail.resetTime)
    : null

  return {
    session: session && {
      pct: session.pct,
      countdown: countdown(session.resetsAt, now),
      at: session.resetsAt ? `${dayWord(session.resetsAt, now)}, ${clockFmt.format(session.resetsAt)}` : null,
      severity: session.severity
    },
    windows: weekly
      ? [{ name: 'Semana', pct: weekly.pct, when: whenLabel(weekly.resetsAt, now), severity: weekly.severity }]
      : [],
    spend: null,
    at: now
  }
}

module.exports = { toKimiViewModel, severityFromPct }
