'use strict'

// Modo demonstracao (CLAUDE_WIDGET_DEMO=1): numeros ficticios, sem ler
// credencial nem tocar a rede. Serve para as imagens do README e para mostrar
// a interface sem expor a conta de ninguem. Datas relativas ao relogio, para a
// contagem regressiva andar de verdade.

const H = 3600_000
const D = 24 * H
const iso = t => new Date(t).toISOString()

function claude (now) {
  const five = now + 2 * H + 18 * 60_000
  const week = now + 3 * D + 5 * H
  return {
    five_hour: { utilization: 42, resets_at: iso(five) },
    limits: [
      { kind: 'session', group: 'session', percent: 42, severity: 'normal', resets_at: iso(five) },
      { kind: 'weekly_all', group: 'weekly', percent: 30, severity: 'normal', resets_at: iso(week) },
      { kind: 'weekly_scoped', group: 'weekly', percent: 12, severity: 'normal', resets_at: iso(week), scope: { model: { display_name: 'Opus' } } }
    ],
    spend: {
      enabled: true,
      used: { amount_minor: 1840, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
      percent: 37,
      severity: 'normal'
    }
  }
}

const RAW = {
  claude: now => ({ raw: claude(now), plan: 'max' }),
  codex: now => ({
    raw: {
      plan_type: 'plus',
      rate_limit: {
        secondary_window: { used_percent: 18, reset_at: Math.round((now + 3 * H + 40 * 60_000) / 1000) },
        primary_window: { used_percent: 9, reset_at: Math.round((now + 5 * D) / 1000) }
      }
    },
    plan: 'plus'
  }),
  kimi: now => ({
    raw: {
      usage: { limit: '100', used: '64', resetTime: iso(now + 4 * D) },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '81', resetTime: iso(now + 52 * 60_000) } }]
    },
    plan: null
  }),
  grok: now => ({
    raw: { config: { creditUsagePercent: 93, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: iso(now + 2 * D) } } },
    plan: null
  }),
  antigravity: now => ({
    raw: {
      tier: { id: 'g1-pro-tier' },
      models: {
        'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.73, resetTime: iso(now + 4 * H + 10 * 60_000) } },
        'claude-sonnet-5-5-high': { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 0.88, resetTime: iso(now + 4 * H + 40 * 60_000) } },
        'gpt-oss-120b-medium': { displayName: 'GPT-OSS', quotaInfo: { remainingFraction: 0.88, resetTime: iso(now + 4 * H + 40 * 60_000) } }
      }
    },
    plan: 'pro'
  }),
  zcode: now => ({
    raw: {
      data: {
        level: 'lite',
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 23, nextResetTime: now + 1 * H + 34 * 60_000 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 11, nextResetTime: now + 6 * D }
        ]
      }
    },
    plan: 'lite'
  }),
  qwen: now => ({
    raw: { kind: 'tokenplan', plan: 'standard', status: 'Active', remainingPct: 78.2, quota: 80000, resetsAt: now + 11 * D },
    plan: 'standard'
  })
}

function demoLoad (id) {
  const make = RAW[id]
  return make ? Promise.resolve(make(Date.now())) : Promise.reject(new Error('sem demo'))
}

module.exports = { demoLoad, enabled: () => process.env.CLAUDE_WIDGET_DEMO === '1' }
