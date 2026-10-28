// Derived counts and touched claim statuses follow the authoritative Status rows.
export function synchronizeContractCounts(source,touched=[]) {
  const start=source.indexOf('\n## Status'),head=source.slice(0,start),tail=source.slice(start)
  const rows=[...tail.matchAll(/^\| `([A-Z]+-\d+)` \|[^|]+\| (published|target|push-further) \| (done|partial|missing) \|/gm)]
    .map(([,id,kind,status])=>({id,kind,status}))
  const states=new Map(rows.map(row=>[row.id,row.status]))
  let result=tail.replace(/^\| (Published|Target and push further|All) \| \d+ \| \d+ \| \d+ \| \d+ \|$/gm,(_line,label)=>{
    const own=rows.filter(row=>label==='All'||label==='Published'&&row.kind==='published'||label==='Target and push further'&&row.kind!=='published')
    const n=status=>own.filter(row=>row.status===status).length
    return `| ${label} | ${n('done')} | ${n('partial')} | ${n('missing')} | ${own.length} |`
  })
  const delta={done:0,partial:0,missing:0}
  let claims=head.replace(/^\| \d+ \|.*\| (done|partial|missing) \|$/gm,(line,old)=>{
    const ids=[...line.matchAll(/`([A-Z]+-\d+)`/g)].map(match=>match[1])
    if(!ids.some(id=>touched.includes(id))||!ids.length||ids.some(id=>!states.has(id)))return line
    const values=ids.map(id=>states.get(id)),status=values.every(value=>value==='done')?'done':values.every(value=>value==='missing')?'missing':'partial'
    delta[old]--;delta[status]++
    return line.replace(/(done|partial|missing) \|$/,`${status} |`)
  })
  claims=claims.replace(/(\d+ claims: )(\d+) done, (\d+) partial, (\d+) missing\./,(_all,prefix,done,partial,missing)=>`${prefix}${Number(done)+delta.done} done, ${Number(partial)+delta.partial} partial, ${Number(missing)+delta.missing} missing.`)
  return claims+result
}
