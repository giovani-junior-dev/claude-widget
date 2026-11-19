'use strict'

// Credencial do Google Antigravity. O CLI (agy) e o app guardam o token OAuth no
// Gerenciador de Credenciais do Windows, alvo "gemini:antigravity", como JSON
// {token:{access_token, refresh_token, expiry}, id_token_email, ...}.
// So leitura: quem renova e o proprio agy, que roda em segundo plano.

const { execFile } = require('node:child_process')
const { CredsError } = require('./creds')

const TARGET = process.env.CLAUDE_WIDGET_ANTIGRAVITY_TARGET || 'gemini:antigravity'
const EXPIRY_SKEW_MS = 60_000

// CredRead via P/Invoke: o Node nao fala com o Credential Manager sem modulo nativo.
// Vai como -EncodedCommand, porque dentro do asar empacotado nao ha .ps1 para apontar.
function script (target) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class CwCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct C { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int Size; public IntPtr Blob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string t, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
  public static string Read(string t) { IntPtr p; if (!CredRead(t, 1, 0, out p)) return null; var c = (C)Marshal.PtrToStructure(p, typeof(C)); var b = new byte[c.Size]; Marshal.Copy(c.Blob, b, 0, b.Length); CredFree(p); return Convert.ToBase64String(b); }
}
'@
$r = [CwCred]::Read('${target.replace(/'/g, "''")}')
if ($r) { [Console]::Out.Write($r) } else { exit 3 }
`
}

function readBlob (target = TARGET) {
  if (process.platform !== 'win32') {
    return Promise.reject(new CredsError('NO_FILE', 'Antigravity só é lido no Windows.'))
  }
  const encoded = Buffer.from(script(target), 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15_000, encoding: 'utf8' },
      (err, stdout) => {
        if (err && err.code === 3) return reject(new CredsError('NO_FILE', 'Antigravity sem login nesta máquina.'))
        if (err) return reject(new CredsError('UNREADABLE', 'Não foi possível ler a credencial do Antigravity.'))
        resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8'))
      })
  })
}

function parse (text, now = Date.now()) {
  let json
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new CredsError('BAD_JSON', 'A credencial do Antigravity não é um JSON válido.')
  }
  const tok = json && json.token
  if (!tok || typeof tok.access_token !== 'string' || tok.access_token === '') {
    throw new CredsError('BAD_SHAPE', 'Credencial do Antigravity sem token utilizável.')
  }
  const expiresAt = typeof tok.expiry === 'string' ? Date.parse(tok.expiry) : NaN
  return {
    token: tok.access_token,
    email: typeof json.id_token_email === 'string' ? json.id_token_email : null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    expired: Number.isFinite(expiresAt) && now >= expiresAt - EXPIRY_SKEW_MS
  }
}

async function readCreds (now = Date.now()) {
  return parse(await readBlob(), now)
}

module.exports = { readCreds, parse, TARGET }
