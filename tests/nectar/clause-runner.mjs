// Focused execution of a contract journey against the real built HTTP Worker.
import { runIsolated } from './isolated.mjs'
await runIsolated(process.argv[2],process.argv[3])
