'use strict'

// Converte /v1/billing?format=credits (visto no fetcher do Orca,
// stablyai/orca) no mesmo formato de tela dos outros provedores.
// Grok nao tem janela curta: so cota semanal, sem "sessao".

const { toDate, whenLabel, pctOf, severityFromPct } = require('./view-model')

function resolveConfig (raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.config && typeof raw.config === 'object') return raw.config
  if (typeof raw.creditUsagePercent === 'number') return raw
  return null
}

// A API omite creditUsagePercent quando e zero (mesma familia de bug do Kimi):
// so assume 0% se o periodo semanal bater com o billing period, senao fica sem dado.
function hasConfirmedWeeklyPeriod (config) {
  const period = config.currentPeriod
  return !!period &&
    period.type === 'USAGE_PERIOD_TYPE_WEEKLY' &&
    Date.parse(period.start) === Date.parse(config.billingPeriodStart) &&
    Date.parse(period.end) === Date.parse(config.billingPeriodEnd)
}

function toGrokViewModel (raw, now = Date.now()) {
  const config = resolveConfig(raw)
  if (!config) return { session: null, windows: [], spend: null, at: now }

  const rawPct = typeof config.creditUsagePercent === 'number'
    ? config.creditUsagePercent
    : (hasConfirmedWeeklyPeriod(config) ? 0 : null)
  const pct = pctOf(rawPct)
  if (pct == null) return { session: null, windows: [], spend: null, at: now }

  const resetsAt = toDate(config.currentPeriod && config.currentPeriod.end || config.billingPeriodEnd)

  return {
    session: null,
    windows: [{ name: 'Semana', pct, when: whenLabel(resetsAt, now), severity: severityFromPct(pct) }],
    spend: null,
    at: now
  }
}

module.exports = { toGrokViewModel }
