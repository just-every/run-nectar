// Wrangler receives only OS process settings and the explicit fixture env file.
// Verification disables dotenv globally; these disposable Workers must load
// their generated bindings without importing the caller's credentials.
export const workerEnvironment = () => ({
  ...Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  CI: 'true',
  WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true',
})
