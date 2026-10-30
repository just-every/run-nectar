import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
const {shards}=JSON.parse(await readFile(new URL('../verification.json',import.meta.url)))
assert.ok(shards.length>0&&shards.length<=8,'Verify declares one to eight shards')
assert.equal(new Set(shards.map(s=>s.name)).size,shards.length)
for(const shard of shards)assert.ok(shard.commands.length&&typeof shard.browser==='boolean')
let tier='full'
const event=process.env.GITHUB_EVENT_PATH?JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH)):{}
// Changed docs reuse the same light path on pushes and PRs. Missing history,
// new branches, dispatch and reusable calls always retain full verification.
const base=event.pull_request?.base?.sha??event.before
if(base&&!/^0+$/.test(base)) {
 try {
  const files=execFileSync('git',['diff','--name-only',base,'HEAD'],{encoding:'utf8'}).trim().split('\n').filter(Boolean)
  if(files.length&&files.every(file=>file.endsWith('.md')&&!['CONTRACT.md','AGENTS.md'].includes(file)))tier='light'
 }catch{/* Shallow or unavailable bases safely take the full tier. */}
}
const matrix=JSON.stringify({include:shards.map(({name,browser})=>({name,browser}))})
if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`tier=${tier}\nmatrix=${matrix}\n`)
console.log(JSON.stringify({tier,shards:shards.map(s=>s.name)}))
