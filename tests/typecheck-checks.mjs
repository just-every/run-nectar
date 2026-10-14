import { fileURLToPath as __rerTestEntryPath } from 'node:url';
const __rerTestEntry = __rerTestEntryPath(import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs'));
const __rerTestEntryArgs = args => args[1] === 'dev' && !args.some(arg => ['--foreground', '--detach', '--stop', '--help'].includes(arg)) ? [...args, '--foreground'] : args;
const __rerTestEntryPnpm = (program, args) => {
 const at = program === 'nice' ? args.indexOf('pnpm') : -1;
 if (program === 'nice' && at < 0) return [program, args];
 const command = at < 0 ? args : args.slice(at + 1), offset = command[0] === 'run' ? 1 : 0;
 const aliases = {"build":"build","dev":"dev","preview":"preview","verify":"verify","setup":"setup","deploy":"deploy","reset":"reset","export":"export","import":"import","release":"release","outbox":"outbox","doctor":"doctor","describe":"describe","check":"check","deps":"install","rer":""}, alias = command[offset];
 if (!Object.hasOwn(aliases, alias)) return [program, args];
 const forwarded = command.slice(offset + 1); if (forwarded[0] === '--') forwarded.shift();
 const launch = __rerTestEntryArgs([__rerTestEntry, ...(aliases[alias] ? [aliases[alias]] : []), ...forwarded]);
 return at < 0 ? [process.execPath, launch] : [program, [...args.slice(0, at), process.execPath, ...launch]];
};
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// The compiler reads installed dependencies, but every source edit and cache
// write belongs to this disposable copy. No build, server or install is run.
export async function checkIncremental(t, project, { context = project, extraSources = [] } = {}) {
 const scratch = await realpath(await mkdtemp(resolve(tmpdir(), 'rer-typecheck-')))
 t.after(() => rm(scratch, { recursive: true, force: true }))
 const copy = resolve(scratch, relative(context, project))
 await mkdir(copy, { recursive: true })
 // Vite config imports maintained build plugins from scripts as well as vite.
 // Keep those dependencies in the isolated compiler copy, with the app source.
 // The edition identity reads the run site declaration beside deploy.json, and
 // the run site's docs read their page list from docs/site.json.
 for (const name of ['src', 'vite', 'scripts', 'vite.config.ts', 'tsconfig.json', 'package.json', '.gitignore', 'deploy-site.json', 'docs']) {
  try { await cp(resolve(project, name), resolve(copy, name), { recursive: true }) }
  catch (error) { if (error.code !== 'ENOENT' || !['vite', '.gitignore', 'deploy-site.json', 'docs'].includes(name)) throw error }
 }
 for (const name of extraSources) await cp(resolve(context, name), resolve(scratch, name), {
  recursive: true, filter: path => !['node_modules', '.cache', '.git', '.dev.vars', '.env'].includes(basename(path)),
 })
 await symlink(resolve(project, 'node_modules'), resolve(copy, 'node_modules'))
 if (context !== project) {
  await cp(resolve(context, 'package.json'), resolve(scratch, 'package.json'))
  await symlink(resolve(context, 'node_modules'), resolve(scratch, 'node_modules'))
 }
 const configPath = resolve(copy, 'tsconfig.json')
 const config = JSON.parse(await readFile(configPath, 'utf8'))
 const cache = resolve(copy, config.compilerOptions.tsBuildInfoFile ?? '.cache/typecheck.tsbuildinfo')
 const sources = {
  'src/typecheck-local.ts': 'export const localValue: number = 1;\n',
  'src/typecheck-model.ts': 'export type CacheModel = { label: string };\n',
  'src/typecheck-consumer.ts': "import type { CacheModel } from './typecheck-model';\nexport const model: CacheModel = { label: 'ready' };\nexport function optionProbe(flag: boolean) { if (flag) return 1; }\n",
 }
 for (const [name, text] of Object.entries(sources)) await writeFile(resolve(copy, name), text)
 const run = (trace) => {
  const args = ['run', 'typecheck', '--verbose', '--extendedDiagnostics', '--pretty', 'false']
  if (trace) args.push('--generateTrace', `.cache/${trace}`)
  const result = spawnSync(...__rerTestEntryPnpm('pnpm', args), { cwd: copy, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 ** 2 })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return { code: result.status, output: result.stdout + result.stderr }
 }
 const clean = (result) => assert.equal(result.code, 0, result.output)
 const cachedGraph = async () => {
  const info = JSON.parse(await readFile(cache, 'utf8'))
  for (const file of Object.keys(sources)) {
   assert.ok(info.fileNames.some(name => name.endsWith('/' + file)), `Warm graph includes ${file}`)
  }
 }
 const error = (result, file, diagnostic) => {
  assert.notEqual(result.code, 0, 'A source error must fail the real package command')
  assert.match(result.output, new RegExp(`${file.replaceAll('.', '\\.')}.*error TS${diagnostic}`), result.output)
 }
 const full = async (result, trace, expectClean = true) => {
  if (expectClean) clean(result)
  assert.match(result.output, /Check time:\s+(?!0\.00)[\d.]+s/, 'Must enter the checker, not just inspect timestamps')
  const traceRoot = resolve(copy, '.cache', trace)
  const traceFiles = (await readdir(traceRoot)).filter(name => /^trace(?:\..*)?\.json$/.test(name))
  assert.equal(traceFiles.length, 1, 'Exactly one project is checked')
  const events = JSON.parse(await readFile(resolve(traceRoot, traceFiles[0]), 'utf8'))
  // TS canonicalizes trace paths on case-insensitive macOS volumes.
  const canonical = path => path?.replaceAll('\\', '/').toLowerCase()
  const checked = new Set(events.filter(event => event.name === 'checkSourceFile').map(event => canonical(event.args?.path)))
  const parsed = new Set(events.filter(event => event.name === 'createSourceFile').map(event => canonical(event.args?.path)))
  const info = JSON.parse(await readFile(cache, 'utf8'))
  const files = info.fileNames.filter(file => /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file))
  assert.ok(files.length >= Object.keys(sources).length + 1)
  for (const file of files) {
   const path = resolve(dirname(cache), file)
   assert.ok(parsed.has(canonical(path)), `Full recheck parses unchanged ${file}`)
   // Generated routes explicitly opt out of semantic checking in the existing
   // source. Preserve that compiler behavior; every other source is checked.
   if (/^\s*\/\/\s*@ts-nocheck\b/m.test(await readFile(path, 'utf8'))) continue
   assert.ok(checked.has(canonical(path)), `Full recheck includes unchanged ${file}`)
  }
 }

 await t.test('cold and deleted-cache runs fully check; unchanged warm run skips the checker', async () => {
  await full(run('cold'), 'cold')
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: copy, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', relative(copy, cache)], { cwd: copy, encoding: 'utf8' })
  assert.equal(ignored.status, 0, 'The generated cache must stay out of commits')
  for (const file of Object.keys(sources)) {
   await assert.rejects(stat(resolve(copy, file.replace(/\.ts$/, '.js'))), { code: 'ENOENT' }, 'Typechecking must not emit application code')
  }
  const before = await stat(cache)
  const warm = run()
  clean(warm)
  assert.match(warm.output, /is up to date/)
  assert.doesNotMatch(warm.output, /Check time:/)
  assert.equal((await stat(cache)).mtimeMs, before.mtimeMs, 'Warm run preserves the metadata')
  await rm(cache)
  await full(run('deleted'), 'deleted')
 })
 await t.test('a new local source error fails, including a repeated unchanged failing run', async () => {
  await cachedGraph()
  await writeFile(resolve(copy, 'src/typecheck-local.ts'), 'export const localValue: number = "wrong";\n')
  error(run(), 'src/typecheck-local.ts', 2322)
  error(run(), 'src/typecheck-local.ts', 2322)
 })
 await t.test('an exported type edit invalidates its unchanged dependent file', async () => {
  await cachedGraph()
  await writeFile(resolve(copy, 'src/typecheck-model.ts'), 'export type CacheModel = { label: number };\n')
  error(run(), 'src/typecheck-consumer.ts', 2322)
 })
 await t.test('reverting both edits restores a clean check and warm skip', async () => {
  await cachedGraph()
  for (const [name, text] of Object.entries(sources)) await writeFile(resolve(copy, name), text)
  clean(run())
  const warm = run()
  clean(warm)
  assert.match(warm.output, /is up to date/)
 })
 await t.test('a changed compiler option detects a previously valid unchanged source', async () => {
  await cachedGraph()
  await writeFile(configPath, JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, noImplicitReturns: true } }))
  const changed = run('options-changed')
  error(changed, 'src/typecheck-consumer.ts', 7030)
  await full(changed, 'options-changed', false)
  await writeFile(configPath, JSON.stringify(config))
  await full(run('options-restored'), 'options-restored')
 })
 await t.test('metadata from a different TypeScript version forces a full recheck', async () => {
  const info = JSON.parse(await readFile(cache, 'utf8'))
  // Represent metadata left by an older compiler; never edit installed TS.
  info.version = '0.0.0-previous-compiler'
  await writeFile(cache, JSON.stringify(info))
  const result = run('version-changed')
  assert.match(result.output, /version.*differs with current version/i)
  await full(result, 'version-changed')
  assert.notEqual(JSON.parse(await readFile(cache, 'utf8')).version, info.version)
 })
}
