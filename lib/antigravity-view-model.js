'use strict'

// Cota do Antigravity em duas fontes:
//   groups  (retrieveUserQuotaSummary): por grupo de modelos, janela semanal e de
//           5 h — o mesmo que o /credits do agy. Hoje traz so "Claude and GPT".
//   models  (fetchAvailableModels): fracao restante por modelo, na janela de 5 h.
//           Cobre o Gemini, que o resumo nao traz.
// A semana do Gemini e a cota da Argon o agy busca por um canal interno que
// outro programa nao alcanca; elas ficam de fora em vez de serem inventadas.

const { toDate, whenLabel, dayWord, pctOf, countdown, severityFromPct } = require('./view-model')

const clockFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

const FAMILIES = [
  [/^gemini/i, 'Gemini'],
  [/^claude/i, 'Claude'],
  [/^gpt/i, 'GPT-OSS']
]

function familyOf (id) {
  const hit = FAMILIES.find(([re]) => re.test(id))
  return hit ? hit[1] : null
}

// "Claude and GPT models" -> "Claude · GPT"
function groupName (displayName) {
  return String(displayName || 'Modelos').replace(/\s+models?$/i, '').replace(/\s+and\s+/i, ' · ')
}

function bucketRow (group, b) {
  const pct = pctOf((1 - b.remainingFraction) * 100)
  if (pct == null) return null
  const weekly = b.window === 'weekly'
  return {
    group,
    window: weekly ? 'week' : '5h',
    name: `${group} · ${weekly ? 'semana' : '5 h'}`,
    pct,
    resetsAt: toDate(b.resetTime),
    severity: severityFromPct(pct)
  }
}

function summaryRows (groups) {
  const rows = []
  const families = new Set()
  for (const g of groups || []) {
    if (!g || !Array.isArray(g.buckets)) continue
    const name = groupName(g.displayName)
    for (const f of FAMILIES) if (new RegExp(f[1].split('-')[0], 'i').test(g.displayName || '')) families.add(f[1])
    for (const b of g.buckets) {
      if (!b || typeof b.remainingFraction !== 'number') continue
      const row = bucketRow(name, b)
      if (row) rows.push(row)
    }
  }
  return { rows, families }
}

// Modelos que dividem a mesma cota chegam com o mesmo par fracao/reset: uma
// linha so por par, nomeada pelas familias. Familias ja cobertas pelo resumo saem.
function modelRows (models, covered) {
  const groups = new Map()
  for (const [id, m] of Object.entries(models || {})) {
    const q = m && m.quotaInfo
    // Sem displayName sao modelos internos (autocomplete, roteadores): nao contam.
    if (!m || !m.displayName || !q || !q.resetTime || typeof q.remainingFraction !== 'number') continue
    const family = familyOf(id)
    if (!family || covered.has(family)) continue
    const key = `${q.remainingFraction}|${q.resetTime}`
    if (!groups.has(key)) groups.set(key, { families: new Set(), remaining: q.remainingFraction, resetTime: q.resetTime })
    groups.get(key).families.add(family)
  }
  return [...groups.values()]
    .map(g => bucketRow([...g.families].join(' · '), { window: '5h', remainingFraction: g.remaining, resetTime: g.resetTime }))
    .filter(Boolean)
}

function pools (raw) {
  const { rows, families } = summaryRows(raw && raw.groups)
  return [...modelRows(raw && raw.models, families), ...rows]
}

function toAntigravityViewModel (raw, now = Date.now()) {
  const list = pools(raw)
  if (!list.length) return { session: null, windows: [], spend: null, at: now }

  // Mostrador: a janela de 5 h mais gasta, que e a que trava primeiro.
  const short = list.filter(r => r.window === '5h').sort((a, b) => b.pct - a.pct)[0] || list[0]
  const order = r => (r.window === '5h' ? 0 : 1)
  const windows = list
    .slice()
    .sort((a, b) => a.group.localeCompare(b.group) || order(a) - order(b))
    .map(r => ({ name: r.name, pct: r.pct, when: whenLabel(r.resetsAt, now), severity: r.severity }))

  return {
    session: {
      pct: short.pct,
      countdown: countdown(short.resetsAt, now),
      at: short.resetsAt ? `${dayWord(short.resetsAt, now)}, ${clockFmt.format(short.resetsAt)}` : null,
      severity: short.severity,
      label: short.name
    },
    windows,
    spend: null,
    at: now
  }
}

function antigravityPlan (raw) {
  const tier = raw && raw.tier
  if (!tier || typeof tier.id !== 'string') return null
  return tier.id.replace(/-tier$/, '').replace(/^g1-/, '')
}

module.exports = { toAntigravityViewModel, antigravityPlan, pools, groupName }
