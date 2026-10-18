// The run site (run-nectar.com) as `rer build --site` writes it: a visitor reaches /run from the homepage's
// primary action, every page's links and files resolve inside the site, and no page links an instance-only
// route or names a loopback address.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../..', import.meta.url).pathname
const site = join(root, 'dist/site')
const pages = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? pages(join(dir, entry.name)) : entry.name.endsWith('.html') ? [join(dir, entry.name)] : [])
const served = path => [path, `${path}.html`, join(path, 'index.html')].some(candidate => existsSync(join(site, candidate)) && !candidate.endsWith('/'))
const attrs = (html, name) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map(match => match[1].replaceAll('&amp;', '&'))

test('the run site builds, its primary action opens /run, and every link and file it names resolves', () => {
  execFileSync(join(root, 'node_modules/.bin/rer'), ['build', '--site'], { cwd: root, stdio: 'pipe' })
  const home = readFileSync(join(site, 'index.html'), 'utf8')
  assert.match(home, /<a class="run" href="\/run">/, 'the homepage leads with Run Nectar to /run')
  assert.ok(served('run'), '/run is built')
  const all = pages(site)
  assert.ok(all.length > 3, 'the homepage, /run, the docs and the not-found page')
  for (const file of all) {
    const html = readFileSync(file, 'utf8'), where = relative(site, file)
    assert.doesNotMatch(html, /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b|RER_[A-Z]/, `${where} names a loopback address or an rer output line`)
    const refs = [...attrs(html, 'href'), ...attrs(html, 'src'), ...attrs(html, 'srcset').flatMap(set => set.split(',').map(part => part.trim().split(/\s+/)[0]))]
    for (const ref of refs.filter(ref => ref.startsWith('/') && !ref.startsWith('//'))) {
      const path = decodeURIComponent(ref.split(/[?#]/)[0])
      assert.doesNotMatch(path, /^\/(signin|login|sign-in|setup|app|auth)(\/|$)/, `${where} links the instance-only ${path}`)
      if (path !== '/') assert.ok(served(path), `${where} names ${path}, which the site does not serve`)
    }
  }
})
