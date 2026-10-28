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
