# Receiving Nectar webhooks

`receiver.mjs` is a small receiving app. It checks each delivery's
`Nectar-Signature` header, refuses a forged, altered or stale delivery with 400,
and handles each event id once, however often it is retried or replayed.

1. In a local installation (`rer dev`), open **More → Webhooks** as the owner or a
   developer and register `http://127.0.0.1:4242/webhooks/nectar`. Local
   installations accept a loopback HTTP receiver; hosted installations accept
   HTTPS on a public host name only. Copy the signing secret: it is shown once.
2. Run `NECTAR_WEBHOOK_SECRETS=<secret> node examples/webhook-receiver/receiver.mjs`
   from the checkout root. It prints each event it handles.
3. To rotate, choose **Rotate secret** with an overlap window, restart the
   receiver with both secrets (`NECTAR_WEBHOOK_SECRETS=<new>,<old>`) and drop the
   old one once the window ends. Until then every delivery carries one `v1`
   signature per secret.

A signature is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
Verify against the raw request body, before parsing it, and reject a `t` more
than five minutes from your clock. Import `verifyNectarSignature` from
`receiver.mjs` to use the same check in another Node app.
