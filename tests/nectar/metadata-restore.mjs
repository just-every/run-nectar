// DEV-005: public rer export/reset/import/export custody in a populated,
// disposable checkout. Run after the metadata browser journey has stopped.
import assert from 'node:assert/strict'
import { readFile,mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command } from './cli.mjs'
assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable populated checkout')
const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'nectar-metadata-'))
const read=async path=>{const bytes=await readFile(path),records=[];for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}})))records.push(record);return records}
const items=records=>records.filter(r=>r.kind==='part').flatMap(r=>r.items).map(({index,...item})=>item)
try{
 const beforeFile=join(scratch,'before.rer'),afterFile=join(scratch,'after.rer')
 await command(root,['export','--output',beforeFile])
 const before=items(await read(beforeFile))
 const metadata=before.filter(r=>r.kind==='row'&&r.table==='nc_metadata_revisions')
 assert.deepEqual([...new Set(metadata.map(r=>r.row.kind))].sort(),['credit-note','customer','invoice','payment','price','subscription'])
 assert.ok(metadata.some(r=>r.row.revision>1),'history is populated before restore')
 // Reset's public removal inventory is limited to this disposable installation.
 await command(root,['reset','--yes'])
 await command(root,['import','--input',beforeFile,'--yes'])
 await command(root,['export','--output',afterFile])
 const after=items(await read(afterFile))
 assert.deepEqual(after,before,'DEV-005 every portable original and metadata revision survives the empty-destination restore')
 assert.deepEqual(after.filter(r=>r.kind==='row'&&r.table==='nc_metadata_revisions'),metadata)
 console.log('DEV-005 rer export/reset/import/export preserves all six metadata kinds, exact strings, history and financial originals')
}finally{await rm(scratch,{recursive:true,force:true})}
