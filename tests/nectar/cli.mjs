import { readFile } from 'node:fs/promises'
import { fileURLToPath as __rerTestEntryPath } from 'node:url'

const __rerTestEntry = __rerTestEntryPath(import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs'));

const __rerTestEntryArgs = args => args[1] === 'dev' && !args.some(arg => ['--foreground', '--detach', '--stop', '--help'].includes(arg)) ? [...args, '--foreground'] : args;
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const env = () => ({ ...process.env, WRANGLER_SEND_METRICS: 'false' })

const redact = output => output.replace(/(rer-dev=|token=|RER_DEV_KEY=)[^&\s"']+/g, '$1[redacted]').slice(-4000)

export async function command(root, args, { refuse = false } = {}) {
  const started=Date.now()
  let code, output
  // A just-closed local Worker can still be releasing the checkout when the next command starts.
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = spawn(process.execPath, __rerTestEntryArgs([__rerTestEntry, ...args]), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: env() })
    output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk })
    code = await new Promise(resolve => child.once('exit', resolve))
    if (code !== 4 || !output.includes('A local process holds this checkout')) break
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  if (refuse) assert.notEqual(code, 0, `${args[0]} must refuse`)
  else assert.equal(code, 0, `rer ${args[0]} failed (exit ${code}):\n${redact(output)}`)
  console.log(`CLI PASS ${args[0]} ${((Date.now()-started)/1000).toFixed(2)}s`)
  return output
}

export async function serving(root, verb, port, extra = []) {
  const child = spawn(process.execPath, __rerTestEntryArgs([__rerTestEntry, verb, '--port', String(port), ...extra]), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: env() })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk })
  for (let attempt = 0; attempt < 1200; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${verb} stopped before readiness (exit ${child.exitCode}):\n${redact(output)}`)
    if (output.includes('RER_READY')) {
      return {
        output: () => output,
        open: () => output.match(/RER_OPEN (\S+)/)?.[1],
        async stop() {
          const exited = () => child.exitCode !== null || child.signalCode !== null
          if (exited()) return
          const stopped = new Promise(resolve => child.once('exit', resolve))
          child.kill('SIGTERM')
          // Stop only this owned foreground process if graceful cleanup stalls.
          const deadline = setTimeout(() => { if (!exited()) child.kill('SIGKILL') }, 30_000)
          try { await stopped } finally { clearTimeout(deadline) }
        },
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  child.kill('SIGTERM')
  throw new Error(`${verb} readiness timeout`)
}

export async function devKey(root) {
  return (await readFile(`${root}/.rer/local/dev-key.env`, 'utf8')).trim().split('=')[1]
}

/** Local dev identity: the key-gated one-click owner sign-in `rer dev` serves. */
export async function signIn(origin, key) {
  const entered = await fetch(`${origin}/auth/dev/enter?as=owner&returnTo=%2Fapp`, { redirect: 'manual', headers: { 'x-rer-dev-key': key } })
  assert.equal(entered.status, 303)
  return entered.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
}
