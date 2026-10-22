// Focused execution of a contract journey against the real built HTTP Worker.
import { execFileSync } from 'node:child_process'
import { runIsolated } from './isolated.mjs'
if(process.env.NECTAR_JOURNEY_RUN)console.log(`JOURNEY RUN ${process.env.NECTAR_JOURNEY_RUN} HEAD ${execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}`)
await runIsolated(process.argv[2],process.argv[3])
