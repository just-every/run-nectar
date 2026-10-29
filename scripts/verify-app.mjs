import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
const config=JSON.parse(await readFile(new URL('../verification.json',import.meta.url)))
const selection=process.env.NECTAR_VERIFY_GROUP
const groups=config.shards
assert.equal(new Set(groups.map(g=>g.name)).size,groups.length,'Shard names are unique')
assert.ok(!selection||selection==='build'||groups.some(g=>g.name===selection),'Unknown verification group')
const run=command=>new Promise((resolve,reject)=>{
 const child=spawn(command,{shell:true,stdio:'inherit',env:process.env})
 child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)))
})
if(!process.env.NECTAR_BUILD_READY)await run('pnpm run build')
if(!selection){await run('pnpm typecheck');await run('node scripts/contract-docs.mjs check');await run('node scripts/check-locales.mjs');await run('pnpm check:deployment-spec');await run('pnpm exec rer check --profile first-party')}
for(const group of groups.filter(g=>!selection||g.name===selection))for(const command of group.commands)await run(command)
