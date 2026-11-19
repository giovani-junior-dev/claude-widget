'use strict'

// Credencial do ZCode (app desktop da Z.ai). O app grava ~/.zcode/v2/credentials.json
// com cada valor cifrado em AES-256-GCM ("enc:v1:<iv>.<tag>.<dados>", base64url).
// A chave e o SHA-256 de um segredo fixo por usuario, o mesmo que o ZCode usa
// quando ZCODE_CREDENTIAL_SECRET nao esta definido. So leitura: nunca regravamos.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { CredsError } = require('./creds')

const CREDS_PATH = process.env.CLAUDE_WIDGET_ZCODE_CREDS_PATH ||
  path.join(os.homedir(), '.zcode', 'v2', 'credentials.json')

const PREFIX = 'enc:v1:'
const TOKEN_KEY = 'oauth:zai:access_token'

function defaultSecret (env = process.env) {
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET
  let user = 'unknown'
  try { user = os.userInfo().username } catch { /* sem usuario: mesmo fallback do ZCode */ }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${user}`
}

function cipherKey (secret) {
  return crypto.createHash('sha256').update(secret).digest()
}

function decrypt (value, key) {
  if (typeof value !== 'string') return null
  if (!value.startsWith(PREFIX)) return value
  const parts = value.slice(PREFIX.length).split('.')
  if (parts.length !== 3) throw new CredsError('BAD_SHAPE', 'Credencial do ZCode em formato inesperado.')
  const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64url'))
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(data), d.final()]).toString('utf8')
  } catch {
    throw new CredsError('BAD_KEY', 'Não foi possível abrir a credencial do ZCode neste usuário.')
  }
}

// Usado so nos testes, para montar uma credencial cifrada igual a do app.
function encrypt (plain, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return PREFIX + [iv, c.getAuthTag(), data].map(b => b.toString('base64url')).join('.')
}

function parse (text, key = cipherKey(defaultSecret())) {
  let json
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new CredsError('BAD_JSON', 'O arquivo de credenciais do ZCode não é um JSON válido.')
  }
  const token = json && decrypt(json[TOKEN_KEY], key)
  // Arquivo existe mas ninguem logou com conta Z.ai: nada a mostrar.
  if (!token) throw new CredsError('NO_FILE', 'ZCode sem login da Z.ai nesta máquina.')
  return { token, expired: false }
}

function readCreds () {
  let text
  try {
    text = fs.readFileSync(CREDS_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw new CredsError('NO_FILE', 'ZCode não encontrado nesta máquina.')
    throw new CredsError('UNREADABLE', 'Não foi possível ler as credenciais do ZCode.')
  }
  return parse(text)
}

module.exports = { readCreds, parse, decrypt, encrypt, cipherKey, defaultSecret, CREDS_PATH, TOKEN_KEY }
