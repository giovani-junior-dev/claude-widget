'use strict'

// Converte /api/monitor/usage/quota/limit da Z.ai (Coding Plan GLM) no formato
// de tela comum. Cada limite traz unit + number: unit 3 = horas, 6 = semanas.
// A janela mais curta vira o mostrador; as outras viram linhas.

const { toDate, whenLabel, dayWord, pctOf, countdown, severityFromPct } = require('./view-model')

const clockFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

const UNIT_SECONDS = { 1: 86400, 3: 3600, 5: 2592000, 6: 604800 }

function seconds (l) {
  const s = UNIT_SECONDS[l.unit]
  return s ? s * (l.number || 1) : Infinity
}

function nameOf (l) {
  const n = l.number || 1
  if (l.type === 'TIME_LIMIT') return 'Ferramentas MCP'
  if (l.unit === 3) return `${n} h`
  if (l.unit === 1) return n === 1 ? 'Dia' : `${n} dias`
  if (l.unit === 6) return n === 1 ? 'Semana' : `${n} semanas`
  if (l.unit === 5) return n === 1 ? 'Mês' : `${n} meses`
  return 'Cota'
}

function pctFor (l) {
  if (typeof l.percentage === 'number') return pctOf(l.percentage)
  if (typeof l.currentValue === 'number' && typeof l.usage === 'number' && l.usage > 0) {
    return pctOf((l.currentValue / l.usage) * 100)
  }
  return null
}

function toZcodeViewModel (raw, now = Date.now()) {
  const data = raw && raw.data
  const limits = data && Array.isArray(data.limits) ? data.limits.filter(l => l && pctFor(l) != null) : []
  if (!limits.length) return { session: null, windows: [], spend: null, at: now }

  // Mostrador so para janela menor que um dia: semana no mostrador enganaria.
  const quotas = limits.filter(l => l.type !== 'TIME_LIMIT').sort((a, b) => seconds(a) - seconds(b))
  const short = quotas.length && seconds(quotas[0]) < 86400 ? quotas[0] : null
  const rest = limits.filter(l => l !== short).sort((a, b) => seconds(a) - seconds(b))

  let session = null
  if (short) {
    const pct = pctFor(short)
    const resetsAt = toDate(short.nextResetTime)
    session = {
      pct,
      countdown: countdown(resetsAt, now),
      at: resetsAt ? `${dayWord(resetsAt, now)}, ${clockFmt.format(resetsAt)}` : null,
      severity: severityFromPct(pct),
      label: nameOf(short)
    }
  }

  return {
    session,
    windows: rest.map(l => {
      const pct = pctFor(l)
      return { name: nameOf(l), pct, when: whenLabel(toDate(l.nextResetTime), now), severity: severityFromPct(pct) }
    }),
    spend: null,
    at: now
  }
}

function zcodePlan (raw) {
  const level = raw && raw.data && raw.data.level
  return typeof level === 'string' && level ? level : null
}

module.exports = { toZcodeViewModel, zcodePlan }
