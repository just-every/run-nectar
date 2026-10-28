import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const rows=text=>text.split('\n').filter(line=>line.startsWith('| ')).map(line=>line.split('|').slice(1,-1).map(cell=>cell.trim()))

const document=name=>readFile(new URL(`../../docs/${name}.md`,import.meta.url),'utf8')

export async function assertTimingTable(observed){
 const timing=await document('retry-table'),table=rows(timing).slice(2)
 assert.equal(table.length,5,'Every published reason group is reconciled')
 for(const [index,codes] of [['processing_error'],['do_not_honor'],['insufficient_funds'],['R01','R09']].entries()){
  const [reason,delay,limit]=table[index],delayHours=Number(delay.match(/^(\d+) elapsed hours$/)?.[1])
  const caps=limit.match(/^(\d+) total attempts.*?(\d+) elapsed days$/)
  assert.ok(caps,'Timing table exposes count and window')
  for(const code of codes)assert.ok(reason.includes(code),`Published timing group names ${code}`)
  for(const code of codes){
   assert.ok(observed.has(code),`The public invoice journey observed ${code}`)
   const actual=observed.get(code)
   assert.deepEqual([delayHours,Number(caps[1]),Number(caps[2])],[actual.delayHours,actual.maxAttempts,actual.windowDays],`${code} timing table equals the frozen policy and public next attempt`)
  }
 }
 assert.match(table[4][1],/^No retry$/)
 for(const code of ['stolen_card','lost_card','authentication_required','R02','R03']){
  assert.ok(observed.has(code));assert.equal(observed.get(code).delayHours,null,`${code} has no scheduled retry`)
 }
}
