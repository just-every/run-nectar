// Keep the edition-owned Verify workflow unchanged: test:flows runs these
// independent browser and archive proofs in the second existing shard.
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'

if (process.env.NECTAR_VERIFY_SHARD !== '0') {
  const root = process.cwd()
  const run = (file, args = [], cwd = root, env = process.env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(cwd, file), ...args], { cwd, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${file} failed: ${signal ?? code}`)))
  })
  await run('tests/nectar/enterprise-identity-browser.mjs')
  await run('tests/nectar/enterprise-identity-browser.mjs', ['linking'])
  const scratch = await mkdtemp(join(tmpdir(), 'nectar-enterprise-verify-'))
  const checkout = join(scratch, 'checkout')
  try {
    const excluded = new Set(['.git', 'node_modules', '.dev.vars', '.wrangler', '.rer', '.cache', '.evidence', 'exports'])
    await cp(root, checkout, { recursive: true, filter: source => source === root || !excluded.has(basename(source)) })
    await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir')
    await run('tests/nectar/enterprise-linking.mjs', ['archive'], checkout, { ...process.env, NECTAR_TEST_CHECKOUT: '1' })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
