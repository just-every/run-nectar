// Generate the derived contract records from the seed's current native parser.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { parseContract } from '../src/base/seed-contract.mjs'
const mode=process.argv[2]
if(!['write','check'].includes(mode))throw new Error('Usage: node scripts/contract-docs.mjs write or check')
let source=await readFile('CONTRACT.md','utf8')
if(mode==='write'){
  // Derive summary rows from the validated Status source. Removing the old
  // summary for this parse permits a status change to regenerate its counts.
  const original=source.split('\n'),start=original.indexOf('| Clauses | Done | Partial | Missing | Total |')
  if(start>=0){
    let end=start+1
    while(original[end]?.startsWith('|'))end++
    const parsed=parseContract([...original.slice(0,start),...original.slice(end)].join('\n'))
    const groups=[['Published',parsed.clauses.filter(c=>c.kind==='published')],['Target and push further',parsed.clauses.filter(c=>c.kind!=='published')],['All',parsed.clauses]]
    const summaryRows=groups.map(([label,rows])=>`| ${label} | ${['done','partial','missing'].map(status=>rows.filter(c=>c.status===status).length).join(' | ')} | ${rows.length} |`)
    original.splice(start+2,end-start-2,...summaryRows)
    source=original.join('\n')
    parseContract(source)
    await writeFile('CONTRACT.md',source)
  }
}
const contract=parseContract(source),lines=source.split('\n')
const prose=value=>String(value).split(/(`[^`]*`)/g).map((part,index)=>index%2?part:part.replace(/(?<![A-Za-z0-9_.\/:@-])([A-Za-z][A-Za-z0-9_-]*)\/([A-Za-z][A-Za-z0-9_-]*)(?![A-Za-z0-9_.\/-])/g,'$1 and $2')).join('')
const escaped=value=>prose(value).replaceAll('|','\\|').replaceAll('\n',' ')
const evidence=clause=>lines[clause.row-1].trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/)[4].trim()
const summary=`${contract.counts.total} clauses: ${contract.counts.done} done, ${contract.counts.partial} partial, ${contract.counts.missing} missing.`
const acceptance=['# Nectar acceptance record','','Generated from [CONTRACT.md](CONTRACT.md). Regenerate with `node scripts/contract-docs.mjs write`.',`Status: **${summary}**`,'',
 '| Clause | Title | Acceptance evidence required | Present proof | Status | Gap |','| --- | --- | --- | --- | --- | --- |',
 ...contract.clauses.map(clause=>`| ${clause.id} | ${escaped(clause.title)} | ${escaped(clause.text.split('**Acceptance evidence:**').slice(1).join('**Acceptance evidence:**')||clause.text)} | ${prose(evidence(clause))} | **${clause.status.toUpperCase()}** | ${escaped(clause.gap)} |`),''].join('\n')
const claims=['## Nectar implementation claims','','Generated from [CONTRACT.md](https://github.com/just-every/run-nectar/blob/main/CONTRACT.md). A partial or missing clause retains the work named in its Gap.',`Status: **${summary}**`,'',
 '| Clause | Title | Status | Present proof | Gap |','| --- | --- | --- | --- | --- |',
 ...contract.clauses.map(clause=>`| ${clause.id} | ${escaped(clause.title)} | ${clause.status} | ${prose(evidence(clause))} | ${escaped(clause.gap)} |`),''].join('\n')
for(const [path,expected] of [['ACCEPTANCE.md',acceptance],['docs/CLAIMS.md',claims]]){
 if(mode==='write'){await mkdir(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.',{recursive:true});await writeFile(path,expected)}
 else if(await readFile(path,'utf8')!==expected)throw new Error(`${path} is stale; run node scripts/contract-docs.mjs write`)
}
console.log(`Contract documents ${mode==='write'?'generated':'current'}: ${summary}`)
