import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runIsolated } from './isolated.mjs'

if(process.argv[2]==='--clause') {
 const file=process.argv[3],name=process.argv[4]
 await runIsolated(file,name,()=>import(`./${file}.mjs`))
 process.exit(0)
}

const journeys=JSON.parse(await readFile(new URL('./journeys.json',import.meta.url)))

const single=process.argv[2]==='--journey'
const selected=process.argv.slice(single?3:2)

assert.ok(!single||selected.length===1,'A child runs exactly one journey')
assert.ok(selected.length===0||selected.every(name=>journeys.some(j=>j.name===name)), 'Unknown sanity journey')

// Every installation also gets fresh network-edge module state. Reusing a
// cached processor fixture can carry earlier journeys' calls into a later one.
for(const journey of journeys.filter(j=>!selected.length||selected.includes(j.name))) {
  if(!single){
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--journey',journey.name],{stdio:'inherit',env:process.env})
      child.on('error',reject)
      child.on('exit',code=>code===0?resolve():reject(new Error(`${journey.name} exited ${code}`)))
    })
    continue
  }
  const started=performance.now()
  const [file,name]=journey.steps[0]
  const first=await import(`./${file}.mjs`)
  await runIsolated(file,name,async()=>({...first,...(journey.businessTimezone?{businessTimezone:journey.businessTimezone}:{}),...(journey.harness?{harnessOptions:first[journey.harness]}:{}),[name]:async(h,owner)=>{
    for(const [step,method] of journey.steps) await (await import(`./${step}.mjs`))[method](h,owner)
  }}))
  if(journey.name==='customerLanguageFlow')await first.translationFiles()
  console.log(`JOURNEY PASS ${journey.name} ${((performance.now()-started)/1000).toFixed(2)}s`)
}
