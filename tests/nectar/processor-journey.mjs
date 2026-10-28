import { processorSetup, processorEventFlow } from './processor-events.mjs'

const {h,owner,edge}=await processorSetup()

try {await processorEventFlow(h,owner,edge);console.log('JOURNEY PASS processor reconciliation')}
finally {await h.close()}
