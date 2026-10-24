import { runIsolated } from './isolated.mjs'
await runIsolated('erasure','erasureFlow',()=>import('./erasure.mjs'))
