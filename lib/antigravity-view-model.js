'use strict'

// Converte a cota por modelo do Antigravity (remainingFraction + resetTime) no
// formato de tela comum. Modelos que dividem a mesma cota chegam com o mesmo
// par fracao/reset: viram uma linha so, nomeada pelas familias que estao nela.

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

function pools (models) {
  const groups = new Map()
  for (const [id, m] of Object.entries(models || {})) {
    const q = m && m.quotaInfo
    // Sem displayName sao modelos internos (autocomplete, roteadores): nao contam.
    if (!m || !m.displayName || !q || !q.resetTime || typeof q.remainingFraction !== 'number') continue
    const family = familyOf(id)
    if (!family) continue
    const key = `${q.remainingFraction}|${q.resetTime}`
    if (!groups.has(key)) groups.set(key, { families: new Set(), remaining: q.remainingFraction, resetsAt: toDate(q.resetTime) })
    groups.get(key).families.add(family)
  }
  return [...groups.values()].map(g => {
    const pct = pctOf((1 - g.remaining) * 100)
    return { name: [...g.families].join(' · '), pct, resetsAt: g.resetsAt, severity: severityFromPct(pct) }
  }).sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name))
}

function toAntigravityViewModel (raw, now = Date.now()) {
  const list = pools(raw && raw.models)
  if (!list.length) return { session: null, windows: [], spend: null, at: now }

  // Mostrador: a cota mais gasta, que e a que vai travar primeiro.
  const top = list[0]
  return {
    session: {
      pct: top.pct,
      countdown: countdown(top.resetsAt, now),
      at: top.resetsAt ? `${dayWord(top.resetsAt, now)}, ${clockFmt.format(top.resetsAt)}` : null,
      severity: top.severity,
      label: top.name
    },
    windows: list.map(p => ({ name: p.name, pct: p.pct, when: whenLabel(p.resetsAt, now), severity: p.severity })),
    spend: null,
    at: now
  }
}

function antigravityPlan (raw) {
  const tier = raw && raw.tier
  if (!tier || typeof tier.id !== 'string') return null
  return tier.id.replace(/-tier$/, '').replace(/^g1-/, '')
}

module.exports = { toAntigravityViewModel, antigravityPlan, pools }
