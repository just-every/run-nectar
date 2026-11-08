import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const require=createRequire('/workspace/run-nectar/package.json')
const {chromium}=require('@playwright/test')
const launch=chromium.launch.bind(chromium)
chromium.launch=options=>launch({...options,executablePath:'/usr/bin/chromium',args:[...(options?.args??[]),'--no-sandbox']})
const [,,script,...args]=process.argv
process.argv=[process.execPath,resolve(script),...args]
await import(pathToFileURL(resolve(script)).href)
