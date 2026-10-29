import type { MetadataFilter, MetadataTarget, MetadataWrite, NectarClient } from '../../../sdks/typescript/src/index.js'

/** Read the retained map and find records containing one exact string pair. */
export async function readMetadataExample(client: NectarClient, target: MetadataTarget, filter: MetadataFilter) {
  const [record, matches] = await Promise.all([
    client.metadata.get(target),
    client.metadata.list({ kind: target.kind, filter }),
  ])
  return { record, matches }
}

/** Explicit complete replacement, using the revision reviewed by the caller. */
export async function replaceMetadataExample(client: NectarClient, input: MetadataWrite, idempotencyKey: string) {
  return client.metadata.write(input, { idempotencyKey })
}
