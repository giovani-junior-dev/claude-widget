'use strict'

// Requisicoes contadas no historico local -> formato de tela comum.
// Janelas moveis: o "reinicia em" do mostrador e quando a requisicao mais
// antiga da janela de 5 h sai dela e devolve uma vaga.

const { countdown, dayWord, pctOf, severityFromPct } = require('./view-model')
const { TIERS, WINDOWS } = require('./qwen-usage')

const clockFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
const intFmt = new Intl.NumberFormat('pt-BR')

function inWindow (times, now, size) {
  return times.filter(t => t > now - size && t <= now)
}

function toQwenViewModel (raw, now = Date.now()) {
  if (!raw || !Array.isArray(raw.requests)) return { session: null, windows: [], spend: null, at: now }
  const tier = TIERS[raw.tier] || TIERS.lite

  const session = inWindow(raw.requests, now, WINDOWS.session)
  const pct = pctOf((session.length / tier.session) * 100)
  const frees = session.length ? new Date(session[0] + WINDOWS.session) : null

  const row = (name, key) => {
    const n = inWindow(raw.requests, now, WINDOWS[key]).length
    const p = pctOf((n / tier[key]) * 100)
    return { name, pct: p, when: `${intFmt.format(n)} / ${intFmt.format(tier[key])}`, severity: severityFromPct(p) }
  }

  return {
    session: {
      pct,
      countdown: frees ? countdown(frees, now) : 'livre',
      at: frees ? `${dayWord(frees, now)}, ${clockFmt.format(frees)}` : `${intFmt.format(tier.session)} requisições livres`,
      severity: severityFromPct(pct),
      label: `${intFmt.format(session.length)} req`
    },
    windows: [row('7 dias', 'week'), row('30 dias', 'month')],
    spend: null,
    estimate: true,
    at: now
  }
}

module.exports = { toQwenViewModel }
