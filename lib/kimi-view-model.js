'use strict'

// Converte /coding/v1/usages (packages/oauth/src/managed-usage.ts do
// MoonshotAI/kimi-code) no mesmo formato de tela que Claude e Codex usam.

const { toDate, whenLabel, dayWord, pctOf, countdown, severityFromPct } = require('./view-model')

const clockFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

const UNIT_SECONDS = { TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86400, TIME_UNIT_WEEK: 604800 }

function toNumber (v) {
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? n : null
}

function rowFrom (detail) {
  if (!detail) return null
  const l = toNumber(detail.limit)
  // A API omite "used" quando e zero (serializacao tipo protobuf): sem isso,
  // "0% usado" virava sessao ausente em vez de barra vazia.
  let u = toNumber(detail.used)
  if (u == null) {
    const remaining = toNumber(detail.remaining)
    if (remaining != null && l != null) u = l - remaining
  }
  if (u == null || l == null || l <= 0) return null
  const pct = pctOf((u / l) * 100)
  if (pct == null) return null
  return { pct, resetsAt: toDate(detail.resetTime), severity: severityFromPct(pct) }
}

function windowSeconds (window) {
  if (!window || typeof window.duration !== 'number') return Infinity
  return window.duration * (UNIT_SECONDS[window.timeUnit] || 0)
}

function toKimiViewModel (raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return { session: null, windows: [], spend: null, at: now }

  const weekly = raw.usage ? rowFrom(raw.usage) : null

  const limits = Array.isArray(raw.limits) ? raw.limits.filter(l => l && l.detail) : []
  const shortest = limits.length
    ? limits.reduce((a, b) => (windowSeconds(a.window) <= windowSeconds(b.window) ? a : b))
    : null
  // So vira "sessao" se for de fato mais curta que a semanal: evita duplicar a mesma janela.
  const session = shortest && windowSeconds(shortest.window) < UNIT_SECONDS.TIME_UNIT_WEEK
    ? rowFrom(shortest.detail)
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

module.exports = { toKimiViewModel }
