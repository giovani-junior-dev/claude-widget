'use strict'

// Converte a resposta crua de /api/oauth/usage no que a tela consome.
// Funcao pura: recebe o relogio por parametro para o teste nao depender da hora real.

const SEVERITY = { normal: 'ok', warning: 'warn', critical: 'crit' }

const LOCALE = 'pt-BR'
const dayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit' })
const clockFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' })

function toDate (value) {
  if (value == null) return null
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d
}

function severityOf (raw) {
  return SEVERITY[raw] || 'ok'
}

function pctOf (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

// "reinicia agora" / "23 min" / "2 h 10" / "dom 02/08"
function countdown (resetsAt, now) {
  if (!resetsAt) return null
  const ms = resetsAt.getTime() - now
  if (ms <= 0) return 'reinicia agora'

  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'reinicia agora'
  if (min < 60) return `${min} min`

  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} h ${String(min % 60).padStart(2, '0')}`

  return dayFmt.format(resetsAt).replace('.', '')
}

// Rotulo curto ao lado da barra: hora se for hoje, dia da semana se for longe.
function whenLabel (resetsAt, now) {
  if (!resetsAt) return null
  const ms = resetsAt.getTime() - now
  if (ms <= 0) return 'agora'
  if (ms < 24 * 3600_000) return clockFmt.format(resetsAt)
  return dayFmt.format(resetsAt).replace('.', '')
}

// "hoje, 01:19" mente quando a sessao reinicia depois da meia-noite.
function dayWord (resetsAt, now) {
  const a = new Date(now)
  const b = resetsAt
  const days = Math.round(
    (new Date(b.getFullYear(), b.getMonth(), b.getDate()) -
     new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400_000
  )
  if (days <= 0) return 'hoje'
  if (days === 1) return 'amanhã'
  return dayFmt.format(resetsAt).replace('.', '')
}

function nameForLimit (limit) {
  if (limit.kind === 'weekly_all') return 'Semana toda'
  const model = limit.scope && limit.scope.model && limit.scope.model.display_name
  if (model) return `${model} · semanal`
  return 'Semana'
}

function money (amount, fallbackCurrency) {
  if (!amount || typeof amount.amount_minor !== 'number') return null
  const currency = typeof amount.currency === 'string' ? amount.currency : fallbackCurrency
  if (!currency) return null
  const exponent = typeof amount.exponent === 'number' ? amount.exponent : 2
  const value = amount.amount_minor / Math.pow(10, exponent)
  try {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).format(value)
  } catch {
    return null
  }
}

function buildSession (raw, limits, now) {
  const fromWindow = raw.five_hour && pctOf(raw.five_hour.utilization)
  const fallback = limits.find(l => l.kind === 'session')

  const pct = fromWindow != null ? fromWindow : (fallback ? pctOf(fallback.percent) : null)
  if (pct == null) return null

  const resetsAt = toDate((raw.five_hour && raw.five_hour.resets_at) || (fallback && fallback.resets_at))
  return {
    pct,
    countdown: countdown(resetsAt, now),
    at: resetsAt ? `${dayWord(resetsAt, now)}, ${clockFmt.format(resetsAt)}` : null,
    severity: severityOf(fallback && fallback.severity)
  }
}

// Percorre limits[] em vez de ler campos fixos: se a Anthropic passar a preencher
// seven_day_opus e companhia, as linhas aparecem sozinhas.
function buildWindows (raw, limits, now) {
  const weekly = limits.filter(l => l.group === 'weekly' && pctOf(l.percent) != null)

  if (weekly.length === 0 && raw.seven_day && pctOf(raw.seven_day.utilization) != null) {
    const resetsAt = toDate(raw.seven_day.resets_at)
    return [{
      name: 'Semana toda',
      pct: pctOf(raw.seven_day.utilization),
      when: whenLabel(resetsAt, now),
      severity: 'ok'
    }]
  }

  return weekly.map(l => ({
    name: nameForLimit(l),
    pct: pctOf(l.percent),
    when: whenLabel(toDate(l.resets_at), now),
    severity: severityOf(l.severity)
  }))
}

function buildSpend (raw) {
  const spend = raw.spend
  if (!spend || spend.enabled === false) return null

  const used = money(spend.used)
  const limit = money(spend.limit, spend.used && spend.used.currency)
  if (used == null) return null

  return {
    used,
    limit,
    pct: pctOf(spend.percent),
    severity: severityOf(spend.severity)
  }
}

function toViewModel (raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') {
    return { session: null, windows: [], spend: null, at: now }
  }
  const limits = Array.isArray(raw.limits) ? raw.limits.filter(Boolean) : []

  return {
    session: buildSession(raw, limits, now),
    windows: buildWindows(raw, limits, now),
    spend: buildSpend(raw),
    at: now
  }
}

// Pior severidade presente decide a cor do icone da bandeja.
function worstSeverity (vm) {
  const all = [
    vm.session && vm.session.severity,
    ...(vm.windows || []).map(w => w.severity),
    vm.spend && vm.spend.severity
  ].filter(Boolean)
  if (all.includes('crit')) return 'crit'
  if (all.includes('warn')) return 'warn'
  return 'ok'
}

module.exports = { toViewModel, worstSeverity, countdown, money, SEVERITY, toDate, whenLabel, dayWord, pctOf }
