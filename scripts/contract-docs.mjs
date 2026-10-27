// Contract rows are the source of status, coverage and claims. No acceptance is authored here.
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {parseContract} from '../src/base/seed-contract.mjs'
const mode=process.argv[2]
if(!['write','check'].includes(mode))throw Error('Use write or check')
const original=readFileSync('CONTRACT.md','utf8'),lines=original.split('\n')
const rows=lines.filter(line=>/^\| `[A-Z][A-Z0-9-]+` \|/.test(line)).map(line=>line.split(/(?<!\\)\|/).slice(1,-1).map(s=>s.trim()))
const count=selected=>[selected.filter(r=>r[3]==='done').length,selected.filter(r=>r[3]==='partial').length,selected.filter(r=>r[3]==='missing').length,selected.length]
const counts=new Map([['Published',count(rows.filter(r=>r[2]==='published'))],['Target and push further',count(rows.filter(r=>r[2]!=='published'))],['All',count(rows)]])
const source=lines.map(line=>{const name=line.split('|')[1]?.trim();return counts.has(name)?`| ${name} | ${counts.get(name).join(' | ')} |`:line}).join('\n')
const contract=parseContract(source),cells=new Map(rows.map(row=>[row[0].replaceAll('`',''),row]))
const prose=text=>text.split(/(`[^`]*`|https?:\/\/[^\s)]+)/g).map((part,index)=>index%2?part:part.replace(/(?<![\w/.:@-])([A-Za-z][A-Za-z0-9_-]*)\/([A-Za-z][A-Za-z0-9_-]*)(?![\w/.-])/g,'$1 / $2')).join('')
const escape=text=>text.replaceAll('|','\\|').replaceAll('\n',' ')
const notice='Generated from CONTRACT.md by `node scripts/contract-docs.mjs write`. Edit the contract, then regenerate.\n'
const totals=`${contract.counts.total} clauses: ${contract.counts.done} done, ${contract.counts.partial} partial, ${contract.counts.missing} missing.`
const acceptance=`# Nectar acceptance record\n\n${notice}\n${totals}\n\n| Clause | Title | Acceptance evidence | Status | Proof | Gap |\n| --- | --- | --- | --- | --- | --- |\n`+contract.clauses.map(c=>{
 const point=c.text.split('**Acceptance evidence:**')[1]?.trim()??c.text,row=cells.get(c.id)
 return `| ${c.id} | ${escape(c.title)} | ${escape(prose(point))} | **${c.status.toUpperCase()}** | ${prose(row[4])} | ${prose(row[5])} |`
}).join('\n')+'\n'
const claims=`# Nectar claims\n\n${notice}\n${totals}\n\n`+contract.clauses.map(c=>{
 const row=cells.get(c.id)
 return `## ${c.id} — ${c.title}\n\nStatus: **${c.status}**.\n\n${prose(c.text)}\n\nProof: ${prose(row[4])||'No completed proof recorded.'}\n\n${row[5]?`Remaining: ${prose(row[5])}\n`:''}`
}).join('\n')
for(const [file,text] of [['CONTRACT.md',source],['ACCEPTANCE.md',acceptance],['docs/CLAIMS.md',claims.trimEnd()+'\n']]){
 if(mode==='write')writeFileSync(file,text)
 else if(!existsSync(file)||readFileSync(file,'utf8')!==text)throw Error(`Generated contract documentation is stale: ${file}`)
}
console.log(`Contract documentation ${mode}: ${totals}`)
