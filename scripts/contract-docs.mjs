// Generate the derived contract records from the seed's current native parser.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { parseContract } from '../src/base/seed-contract.mjs'
const mode=process.argv[2]
if(!['write','check'].includes(mode))throw new Error('Usage: node scripts/contract-docs.mjs write or check')
const source=await readFile('CONTRACT.md','utf8'),original=source.split('\n')
const summaryHeader=/^\|\s*Clauses\s*\|\s*Done\s*\|\s*Partial\s*\|\s*Missing\s*\|\s*Total\s*\|\s*$/
let inStatus=false,inSummary=false
// Parse every source clause before regenerating only the derived counts.
// Blank lines retain source line numbers; the strict parser still validates
// definitions, status rows, evidence and all other contract requirements.
const operands=original.map(line=>{
  if(/^## /.test(line))inStatus=line.trim()==='## Status'
  if(inStatus&&summaryHeader.test(line))inSummary=true
  if(inSummary&&!line.startsWith('|'))inSummary=false
  if(inStatus&&inSummary)return ''
  return line
})
const parsed=parseContract(operands.join('\n'))
const counts=rows=>({done:rows.filter(row=>row.status==='done').length,partial:rows.filter(row=>row.status==='partial').length,missing:rows.filter(row=>row.status==='missing').length,total:rows.length})
const kinds=label=>label.toLowerCase()==='all'?null:label.toLowerCase().split(/\s+and\s+/).map(kind=>kind.trim().replace(/\s+/g,'-'))
inStatus=false;inSummary=false
const lines=original.map(line=>{
  if(/^## /.test(line))inStatus=line.trim()==='## Status'
  if(inStatus&&summaryHeader.test(line)){inSummary=true;return line}
  if(inSummary&&!line.startsWith('|'))inSummary=false
  if(!inStatus||!inSummary||/^\|[\s:|-]+\|$/.test(line))return line
  const cells=line.split('|').slice(1,-1).map(cell=>cell.trim()),selected=kinds(cells[0])
  const tally=counts(selected?parsed.clauses.filter(clause=>selected.includes(clause.kind)):parsed.clauses)
  return `| ${cells[0]} | ${tally.done} | ${tally.partial} | ${tally.missing} | ${tally.total} |`
})
const regenerated=lines.join('\n'),contract=parseContract(regenerated)
if(mode==='write'&&source!==regenerated)await writeFile('CONTRACT.md',regenerated)
if(mode==='check'&&source!==regenerated)throw new Error('CONTRACT.md summary is stale; run node scripts/contract-docs.mjs write')
const prose=value=>String(value).split(/(`[^`]*`)/g).map((part,index)=>index%2?part:part.replace(/(?<![A-Za-z0-9_.\/:@-])([A-Za-z][A-Za-z0-9_-]*)\/([A-Za-z][A-Za-z0-9_-]*)(?![A-Za-z0-9_.\/-])/g,'$1 and $2')).join('')
const escaped=value=>prose(value).replaceAll('|','\\|').replaceAll('\n',' ')
const evidence=clause=>lines[clause.row-1].trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/)[4].trim()
const summary=`${contract.counts.total} clauses: ${contract.counts.done} done, ${contract.counts.partial} partial, ${contract.counts.missing} missing.`
const acceptance=['# Nectar acceptance record','','Generated from [CONTRACT.md](CONTRACT.md). Regenerate with `node scripts/contract-docs.mjs write`.',`Status: **${summary}**`,'',
 '| Clause | Title | Acceptance evidence required | Present proof | Status | Gap |','| --- | --- | --- | --- | --- | --- |',
 ...contract.clauses.map(clause=>`| ${clause.id} | ${escaped(clause.title)} | ${escaped(clause.text.split('**Acceptance evidence:**').slice(1).join('**Acceptance evidence:**')||clause.text)} | ${prose(evidence(clause))} | **${clause.status.toUpperCase()}** | ${escaped(clause.gap)} |`),''].join('\n')
const claims=['# Nectar implementation claims','','Generated from [CONTRACT.md](../CONTRACT.md). A partial or missing clause retains the work named in its Gap.',`Status: **${summary}**`,'',
 '| Clause | Title | Status | Present proof | Gap |','| --- | --- | --- | --- | --- |',
 ...contract.clauses.map(clause=>`| ${clause.id} | ${escaped(clause.title)} | ${clause.status} | ${prose(evidence(clause))} | ${escaped(clause.gap)} |`),''].join('\n')
for(const [path,expected] of [['ACCEPTANCE.md',acceptance],['docs/CLAIMS.md',claims]]){
 if(mode==='write'){await mkdir(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.',{recursive:true});await writeFile(path,expected)}
 else if(await readFile(path,'utf8')!==expected)throw new Error(`${path} is stale; run node scripts/contract-docs.mjs write`)
}
console.log(`Contract documents ${mode==='write'?'generated':'current'}: ${summary}`)
