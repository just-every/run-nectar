import { access } from 'node:fs/promises';
import { join } from 'node:path';

// Nectar's executable suites read product source and fixtures, not the contract
// documents. These command forms and their readers are reviewed with the plan;
// any new command or undeclared reader conservatively requires full coverage.
const documents = new Set(['CONTRACT.md', 'ACCEPTANCE.md', 'docs/CLAIMS.md', 'CLAIMS.md', 'HANDOVER.md', 'STATUS.md']);
const allowed = path => documents.has(path) || path === 'sources.lock.json' || /^(?:evidence|\.artifacts)\/.+\.(?:md|txt|png|jpe?g|pdf)$/.test(path);
const scripts = {
 'pnpm run test:runtime': 'tests/runtime.mjs',
 'pnpm run test:flows': 'tests/nectar/flows.mjs',
 'pnpm run test:journey': 'tests/nectar/journey.mjs',
};
const checks = new Set(['node scripts/contract-docs.mjs check', 'node scripts/edition-authoring/cli.mjs check',
 'pnpm run check', 'pnpm run typecheck', 'pnpm run build --site']);
const relative = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/')
 && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..');

export async function lightReaders(files, { cwd = process.cwd(), plan } = {}) {
 if (!files.length || !files.every(allowed) || !plan?.readers || typeof plan.readers !== 'object' || Array.isArray(plan.readers)) return;
 for (const [path, dependencies] of Object.entries(plan.readers)) {
  if (!/^tests\/[A-Za-z0-9_./-]+\.mjs$/.test(path) || !relative(path)
   || !Array.isArray(dependencies) || !dependencies.every(relative)) return;
 }
 for (const path of ['edition.json', 'sources.lock.json', 'scripts/edition-authoring/cli.mjs']) await access(join(cwd, path));
 const tests = new Set(), changed = new Set(files);
 for (const shard of [...plan.push, ...plan.nightly]) for (const command of shard.commands) {
  if (checks.has(command)) continue;
  const normalized = command.replace(/^(?:NECTAR_VERIFY_SHARD=[01]|NECTAR_TEST_CHECKOUT=1) /, '');
  const test = scripts[normalized] ?? /^node (tests\/[A-Za-z0-9_./-]+\.mjs)(?: [A-Za-z0-9-]+)*$/.exec(normalized)?.[1];
  if (!test || !Object.hasOwn(plan.readers, test)) return;
  await access(join(cwd, test));
  tests.add(test);
 }
 const commands = new Set();
 for (const path of tests) if (plan.readers[path].some(dependency => changed.has(dependency))) {
  // Keep the exact invocation, including its partition and scenario arguments.
  for (const shard of [...plan.push, ...plan.nightly]) for (const command of shard.commands) {
   if (command.includes(path) || scripts[command.replace(/^(?:NECTAR_VERIFY_SHARD=[01]|NECTAR_TEST_CHECKOUT=1) /, '')] === path) commands.add(command);
  }
 }
 if (files.some(path => documents.has(path))) {
  await access(join(cwd, 'scripts/contract-docs.mjs'));
  commands.add('node scripts/contract-docs.mjs check');
 }
 return [...commands];
}
