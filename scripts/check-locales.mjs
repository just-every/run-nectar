// PORT-006: fails when any translation file is incomplete, so a missing string
// fails the check instead of showing a key. Usage: node scripts/check-locales.mjs [dir]
import { readFile, readdir } from 'node:fs/promises'
import { catalogueProblems } from '../src/nectar/locale-keys.ts'

const dir = process.argv[2] ?? new URL('../src/nectar/locales/', import.meta.url).pathname
const base = JSON.parse(await readFile(`${dir}/en.json`, 'utf8'))
let failed = false
for (const name of (await readdir(dir)).filter(n => n.endsWith('.json') && n !== 'en.json').sort()) {
  const problems = catalogueProblems(base, JSON.parse(await readFile(`${dir}/${name}`, 'utf8')))
  for (const problem of problems) console.error(`${name}: ${problem}`)
  failed ||= problems.length > 0
}
if (failed) process.exit(1)
console.log('locales complete')
