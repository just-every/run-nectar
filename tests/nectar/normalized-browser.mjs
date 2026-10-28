import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { runIsolated } from './isolated.mjs'

const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/normalized-metrics'
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
try {
  for (const [file, name] of [['normalized-metrics','normalizedMetricsFlow'], ['draft-corrections','draftCorrectionsFlow'], ['credit-correction','creditCorrectionFlow']]) {
    const module = await import(`./${file}.mjs`)
    await runIsolated(file, name, async () => ({ [name]: async (h, owner) => {
      const context = await browser.newContext()
      try {
        await context.addCookies(owner.split('; ').map(part => { const at = part.indexOf('='); return { name: part.slice(0, at), value: part.slice(at+1), url: h.origin } }))
        const page = await context.newPage(), seen = new Set()
        await module[name](h, owner, async state => {
          const label = `${file}-${state.label}-${state.id ?? ''}`
          if (seen.has(label)) return
          seen.add(label)
          const path = state.path ?? `/app/proposals/${state.id}`
          for (const width of [1440,390]) {
            await page.setViewportSize({ width, height: 1000 })
            const response = await page.goto(h.origin + path)
            assert.equal(response.status(), 200)
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label} fits ${width}`)
            assert.deepEqual(await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()&&node.querySelector('svg,img')&&!node.getAttribute('aria-describedby')).map(node=>node.outerHTML)), [], 'Icon controls have tooltips')
            assert.ok((await page.locator('main').innerText()).length > 100)
            await page.screenshot({ path: `${directory}/${width}-${label}.jpg`, fullPage: true, type: 'jpeg', quality: 65 })
            console.log('BROWSER',width,label)
          }
        })
      } finally { await context.close() }
    } }))
  }
} finally { await browser.close() }
