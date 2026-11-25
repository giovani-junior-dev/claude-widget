'use strict'

// Converte a resposta de /backend-api/wham/usage no mesmo formato de tela que
// o Claude usa (session/windows/spend), pra reaproveitar o resto do widget.

const { toDate, whenLabel, dayWord, pctOf, countdown, severityFromPct } = require('./view-model')

const clockFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

function buildWindow (w) {
  if (!w) return null
  const pct = pctOf(w.used_percent)
  if (pct == null) return null
  const resetsAt = toDate(typeof w.reset_at === 'number' ? w.reset_at * 1000 : null)
  return { pct, resetsAt, severity: severityFromPct(pct) }
}

// A API ja mandou a 5 h em secondary_window e hoje manda em primary_window.
// Decide pela duracao (limit_window_seconds), nao pela posicao: ate 1 dia e a
// janela curta. Sem duracao, vale a ordem antiga (secondary = curta).
const DAY_S = 86_400

function splitWindows (rateLimit) {
  const ws = [rateLimit.primary_window, rateLimit.secondary_window]
    .filter(w => w && typeof w === 'object')
  const sized = ws.filter(w => typeof w.limit_window_seconds === 'number')
  if (sized.length === ws.length && ws.length > 0) {
    return {
      short: ws.find(w => w.limit_window_seconds <= DAY_S) || null,
      long: ws.find(w => w.limit_window_seconds > DAY_S) || null
    }
  }
  return { short: rateLimit.secondary_window, long: rateLimit.primary_window }
}

function toCodexViewModel (raw, now = Date.now()) {
  const rateLimit = raw && typeof raw === 'object' ? raw.rate_limit : null
  if (!rateLimit) return { session: null, windows: [], spend: null, at: now }

  // Janela curta (5 h) vira o mostrador; a semanal (sempre presente) vira linha.
  // Sem janela curta, o mostrador fica vazio em vez de mentir usando a semanal.
  const { short, long } = splitWindows(rateLimit)
  const session5h = buildWindow(short)
  const weekly = buildWindow(long)

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

module.exports = { toCodexViewModel }
