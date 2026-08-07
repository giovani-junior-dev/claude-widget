'use strict'

// Converte a resposta de /backend-api/wham/usage no mesmo formato de tela que
// o Claude usa (session/windows/spend), pra reaproveitar o resto do widget.

const { toDate, whenLabel, dayWord, pctOf, countdown } = require('./view-model')

const clockFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

// A API do Codex nao manda severidade pronta feito a da Anthropic: aplica os
// mesmos cortes usados no resto do widget (>=90 critico, >=75 atencao).
function severityFromPct (pct) {
  if (pct >= 90) return 'crit'
  if (pct >= 75) return 'warn'
  return 'ok'
}

function buildWindow (w) {
  if (!w) return null
  const pct = pctOf(w.used_percent)
  if (pct == null) return null
  const resetsAt = toDate(typeof w.reset_at === 'number' ? w.reset_at * 1000 : null)
  return { pct, resetsAt, severity: severityFromPct(pct) }
}

function toCodexViewModel (raw, now = Date.now()) {
  const rateLimit = raw && typeof raw === 'object' ? raw.rate_limit : null
  if (!rateLimit) return { session: null, windows: [], spend: null, at: now }

  // Janela curta (5 h) vira o mostrador; a semanal (sempre presente) vira linha.
  // Sem janela curta, o mostrador fica vazio em vez de mentir usando a semanal.
  const session5h = buildWindow(rateLimit.secondary_window)
  const weekly = buildWindow(rateLimit.primary_window)

  return {
    session: session5h && {
      pct: session5h.pct,
      countdown: countdown(session5h.resetsAt, now),
      at: session5h.resetsAt ? `${dayWord(session5h.resetsAt, now)}, ${clockFmt.format(session5h.resetsAt)}` : null,
      severity: session5h.severity
    },
    windows: weekly
      ? [{ name: 'Semana', pct: weekly.pct, when: whenLabel(weekly.resetsAt, now), severity: weekly.severity }]
      : [],
    spend: null,
    at: now
  }
}

module.exports = { toCodexViewModel, severityFromPct }
