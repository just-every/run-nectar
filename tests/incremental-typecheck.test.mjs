import { test } from 'node:test'
import { resolve } from 'node:path'
import { checkIncremental } from './typecheck-checks.mjs'

test('exported foundation incremental typecheck', async t => {
 await checkIncremental(t, resolve(import.meta.dirname, '..'))
})
