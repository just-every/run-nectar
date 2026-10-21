import type { Row } from '../core'
import { field,h,select } from './html'
export const intervalFields=()=>h`${select('Billing interval','billing_interval',[{value:'month',label:'Monthly / every N months'},{value:'quarterly',label:'Quarterly'},{value:'semiannual',label:'Semi-annually'},{value:'annual',label:'Annually'},{value:'week',label:'Weekly'}],'month')}${field('Interval multiplier','interval_count',{type:'number',value:1,hint:'For example: monthly × 2 bills every two months.'})}${select('Billing timing','billing_timing',[{value:'arrears',label:'In arrears — after service'},{value:'advance',label:'In advance — before service'}],'arrears',{hint:'Metered usage is billed in arrears.'})}`
export function intervalLabel(price:Row) {
  const terms=price.billing??(price.interval_unit?{unit:price.interval_unit,count:price.interval_count,timing:price.billing_timing}:{unit:'month',count:1,timing:'arrears'})
  const name=terms.unit==='month'&&terms.count===12?'Annually':terms.unit==='month'&&terms.count===6?'Semi-annually':terms.unit==='month'&&terms.count===3?'Quarterly':terms.count===1?({month:'Monthly',week:'Weekly',day:'Daily'} as Row)[terms.unit]:`Every ${terms.count} ${terms.unit}s`
  return `${name} · ${terms.timing==='advance'?'in advance':'in arrears'}`
}
