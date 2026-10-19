import type { Line, RatingInput, Rating } from './rating'

const recurring = (line: Line) => ['flat','seat','discount'].includes(line.kind)

/** Show unused service honestly as a signed credit on the unissued final bill. */
export function cancellationLines(input: RatingInput, lines: Line[], rate: (input: RatingInput) => Rating): Line[] {
  const cancels = (input.lifecycle ?? []).filter(i=>i.kind==='cancellation' && i.from < input.period.end && (i.to ?? '9999') > input.period.start)
  if (!cancels.length) return lines
  const common = {...input, subscription:{...input.subscription,endDate:null},events:[],charges:[],
    amendments:input.amendments.filter(a=>a.kind!=='fixed_credit')}
  const gross = rate({...common,lifecycle:(input.lifecycle ?? []).filter(i=>i.kind!=='cancellation')}).lines.filter(recurring)
  const earned = rate({...common,lifecycle:(input.lifecycle ?? []).filter(i=>i.kind!=='cancellation' || i.creditUnused!==false || i.from<input.period.start)}).lines.filter(recurring)
  const credits: Line[] = []
  for(const taxable of [true,false]) {
    const before=gross.filter(l=>l.taxable===taxable),after=earned.filter(l=>l.taxable===taxable)
    const amount=after.reduce((n,l)=>n+l.amountCents,0)-before.reduce((n,l)=>n+l.amountCents,0)
    if (!amount) continue
    credits.push({kind:'cancellation_credit',description:'Prorated credit for unused recurring service',quantity:'1',unitAmount:'',amountCents:amount,
      taxable,priceId:null,meterId:null,periodStart:input.period.start,periodEnd:input.period.end,
      evidence:{rule:'earned recurring lines minus full recurring lines, each rated exactly before subtraction',transitions:cancels.map(i=>i.id),gross:before,earned:after}})
  }
  return [...gross,...credits,...lines.filter(l=>!recurring(l))]
}
