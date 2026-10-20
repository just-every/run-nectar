// DEV-002: writes src/nectar/api-fields.ts, the body fields each JSON action
// reads, by following each registered handler (and every function it hands its
// Input to) through the source. `--check` fails when the file is out of date.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const dir = join(root, 'src/nectar')
const target = join(dir, 'api-fields.ts')
const KINDS = new Set(['text', 'integer', 'list', 'json', 'flag', 'file', 'has'])

const files = new Map()
function source(path) {
  if (files.has(path)) return files.get(path)
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
  const functions = new Map(), imports = new Map(), constants = new Map()
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement)
    if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) functions.set(d.name.text, d.initializer)
      else if (ts.isIdentifier(d.name) && d.initializer) {
        const value = ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer
        if (ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteral)) constants.set(d.name.text, value.elements.map(e => e.text))
      }
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      const spec = statement.moduleSpecifier.text
      if (!spec.startsWith('.')) continue
      for (const e of statement.importClause.namedBindings.elements) imports.set(e.name.text, { file: resolve(dirname(path), spec) + '.ts', name: (e.propertyName ?? e.name).text })
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const spec = statement.moduleSpecifier.text
      for (const e of statement.exportClause.elements) imports.set(e.name.text, { file: resolve(dirname(path), spec) + '.ts', name: (e.propertyName ?? e.name).text })
    }
  }
  const entry = { sf, functions, imports, constants }
  files.set(path, entry)
  return entry
}

function resolveFn(path, name) {
  const { functions, imports } = source(path)
  if (functions.has(name)) return { path, node: functions.get(name) }
  const imported = imports.get(name)
  return imported ? resolveFn(imported.file, imported.name) : null
}

// String-array constants (`const X = ['a', 'b'] as const`), local or imported.
function constant(path, name) {
  const { constants, imports } = source(path)
  if (constants.has(name)) return constants.get(name)
  const imported = imports.get(name)
  return imported ? constant(imported.file, imported.name) : null
}

function collect(path, node, fields, seen) {
  const key = `${path}:${node.pos}`
  if (seen.has(key)) return
  seen.add(key)
  const param = node.parameters.find(p => /\bInput$/.test(p.type?.getText() ?? '') && ts.isIdentifier(p.name))
  if (!param) return
  const input = param.name.text
  const visit = n => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const own = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === input
      if (own && KINDS.has(callee.name.text) && n.arguments[0]) {
        const field = n.arguments[0], kind = callee.name.text
        if (!ts.isStringLiteral(field)) fields['*'] = 'has'
        else if (!fields[field.text] || fields[field.text] === 'has') fields[field.text] = kind
      } else if (own && callee.name.text === 'only' && n.arguments[0] && ts.isArrayLiteralExpression(n.arguments[0])) {
        for (const e of n.arguments[0].elements) {
          const names = ts.isStringLiteral(e) ? [e.text] : ts.isSpreadElement(e) && ts.isIdentifier(e.expression) ? constant(path, e.expression.text) : null
          if (!names) { fields['*'] = 'has'; continue }
          for (const name of names) if (name !== 'returnTo' && !fields[name]) fields[name] = 'has'
        }
      } else if (ts.isIdentifier(callee) && n.arguments.some(a => ts.isIdentifier(a) && a.text === input)) {
        const found = resolveFn(path, callee.text)
        if (found) collect(found.path, found.node, fields, seen)
        else fields['*'] = 'has'
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node.body)
}

const actionsPath = join(dir, 'actions.ts')
const { sf } = source(actionsPath)
const result = {}
sf.forEachChild(function find(n) {
  if (ts.isVariableDeclaration(n) && n.name.getText() === 'actions' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
    for (const p of n.initializer.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.initializer)) throw new Error(`actions entry ${p.getText()} is not a named handler`)
      const name = ts.isStringLiteral(p.name) ? p.name.text : p.name.getText()
      const found = resolveFn(actionsPath, p.initializer.text)
      if (!found) throw new Error(`cannot resolve handler for ${name}`)
      const fields = {}
      collect(found.path, found.node, fields, new Set())
      result[name] = Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)))
    }
  }
  ts.forEachChild(n, find)
})
const sorted = Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
const text = `// Generated by scripts/api-fields.mjs from the action handlers (DEV-002); do not edit.\n// Each JSON action's body fields and how its handler reads them; '*' marks an\n// action that also reads fields named at run time.\nexport type FieldKind = 'text' | 'integer' | 'list' | 'json' | 'flag' | 'file' | 'has'\n\nexport const API_FIELDS: Record<string, Record<string, FieldKind>> = ${JSON.stringify(sorted, null, 2)}\n`
if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(target, 'utf8') } catch {}
  if (current !== text) { console.error('src/nectar/api-fields.ts is out of date: run node scripts/api-fields.mjs'); process.exit(1) }
} else writeFileSync(target, text)
