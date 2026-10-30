// CLI recovery owns a disposable checkout; never reset the working install.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
let passed=false
const root=process.cwd(),target=await mkdtemp(join(tmpdir(),'nectar-recovery-'))
try {
 const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\0').filter(Boolean)
 for(const file of new Set(files)) {
   // Deleted tracked files are absent during an uncommitted local test.
   await mkdir(dirname(join(target,file)),{recursive:true})
   await cp(join(root,file),join(target,file)).catch(error=>{if(error.code!=='ENOENT')throw error})
 }
 await symlink(join(root,'node_modules'),join(target,'node_modules'),'dir')
 await cp(join(root,'dist'),join(target,'dist'),{recursive:true})
 const child=spawn(process.execPath,['tests/nectar/recovery.mjs',...process.argv.slice(2).filter(arg=>arg!=='--smoke'),...((process.argv.includes('--smoke')||process.env.NECTAR_RECOVERY_FULL==='0')?['--smoke']:[])],{cwd:target,stdio:'inherit',env:{...process.env,NECTAR_TEST_CHECKOUT:'1'}})
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
 assert.equal(code,0,'Public CLI recovery journey passes')
 passed=true
} finally {
 if(passed||!process.env.NECTAR_KEEP_FAILED_WORK)await rm(target,{recursive:true,force:true})
 else console.log('Recovery fixture retained at '+target)
}
