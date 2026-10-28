#!/usr/bin/env node
import process from 'node:process'
import { NectarApiError } from '../../../sdks/typescript/src/index.js'
import { clientsFromEnvironment, eventFromEnvironment, metadataFromEnvironment } from './config.js'
import { meterThenGate } from './meter-then-gate.js'
import { readMetadataExample } from './metadata.js'

async function main() {
  const { client, readClient } = clientsFromEnvironment(process.env)
  // Validate all requested local inputs before recording an event.
  const input = eventFromEnvironment(process.env)
  const metadata = metadataFromEnvironment(process.env)
  const result = await meterThenGate(client, input, readClient)
  if (result.allowed) {
    console.log(JSON.stringify({ outcome: 'allowed', message: 'Feature access granted by Nectar.', ...result }))
  } else {
    console.log(JSON.stringify({ outcome: 'denied', message: 'Feature access denied by Nectar.', ...result }))
  }
  if (metadata) console.log(JSON.stringify(await readMetadataExample(readClient, metadata.target, metadata.filter)))
}

main().catch((error: unknown) => {
  // Never print headers, cookies or tokens, or an arbitrary upstream response body.
  if (error instanceof NectarApiError) console.error(JSON.stringify({ error: error.code ?? 'nectar_http_error', status: error.status, version: error.version }))
  else console.error(error instanceof Error ? error.message : 'The SDK example failed')
  process.exitCode = 1
})
