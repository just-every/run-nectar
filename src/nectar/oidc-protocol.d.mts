export function configure(input: unknown): any
export function discover(fetcher: typeof fetch, provider: any, settings: any): Promise<any>
export function exchange(fetcher: typeof fetch, link: any, provider: any, settings: any, code: string, verifier: string, now: number): Promise<any>
export function readJson(fetcher: typeof fetch, uri: string, settings: any, init?: RequestInit, maxBytes?: number): Promise<any>
export function parseIdToken(token: string, link: any): any
export function verifyIdToken(parsed: any, keys: any, link: any, provider: any, settings: any, transaction: any, tokens: any, now: number): Promise<any>
export function digest(value: string): Promise<string>
export function random(): string
export function isRandom(value: unknown): boolean
export function seal(secret: string, hash: string, value: unknown): Promise<string>
export function unseal(secret: string, hash: string, value: string): Promise<any>
export function keyedHash(secret: string, purpose: string, value: string): Promise<string>
export function refuseInProduction(principal: unknown, config: unknown): void
