// YITOKEN changes: public HTTPS-only asset download with DNS pinning and bounded IO.
// Licensed under AGPL-3.0-or-later. See LICENSE and NOTICE.md.
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import https from 'node:https'
import fs from 'node:fs'

export const MAX_FILM_CLIP_BYTES = 512 * 1024 * 1024
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6 || address.includes('.')) return false
  const [first, second] = address.toLowerCase().split(':').map(part => parseInt(part || '0', 16))
  // Only globally routable 2000::/3; reject transition and documentation ranges.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
}

export function validateFilmDownloadUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid film source URL')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Invalid film source URL') }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host) || (isIP(host) && !isPublicAddress(host))) throw new Error('Film assets require credential-free public HTTPS URLs')
  for (const key of url.searchParams.keys()) {
    if (/^(?:api[-_]?key|key|access[-_]?token|token|authorization|auth|password|secret)$/i.test(key)) throw new Error('API credentials are not permitted in film download URLs')
  }
  return url
}

type Address = { address: string; family: number }
type Lookup = (hostname: string) => Promise<Address[]>
export async function resolvePublicDownloadTarget(value: string, lookup: Lookup = host => dnsLookup(host, { all: true, verbatim: true })) {
  const url = validateFilmDownloadUrl(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(hostname)
  const addresses = literal ? [{ address: hostname, family: literal }] : await lookup(hostname)
  if (addresses.length === 0 || addresses.some(item => !isPublicAddress(item.address) || ![4, 6].includes(item.family))) throw new Error('All film download DNS addresses must be public')
  return { url, address: addresses[0].address, family: addresses[0].family }
}

export async function downloadFilmAsset(value: string, destination: string, signal: AbortSignal, maxBytes = MAX_FILM_CLIP_BYTES, accept = 'video/*, application/octet-stream;q=0.8'): Promise<void> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) controller.abort()
  const timeout = setTimeout(cancel, 120_000)
  let file: fs.promises.FileHandle | undefined
  let created = false
  let completed = false
  try {
    if (controller.signal.aborted) throw new Error('Film download cancelled')
    const target = await Promise.race([
      resolvePublicDownloadTarget(value),
      new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Film download cancelled or timed out')), { once: true })),
    ])
    if (controller.signal.aborted) throw new Error('Film download cancelled')
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = https.get(target.url, {
        signal: controller.signal,
        agent: false,
        family: target.family,
        // Pin the IP that was checked above. TLS still verifies the original hostname.
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        headers: { Accept: accept },
      }, response => { response.on('error', () => {}); resolve(response) })
      request.on('error', () => reject(new Error('Film asset HTTPS download failed')))
    })
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`Film download rejected (${response.statusCode || 0}); redirects are not followed`) }
    const declared = response.headers['content-length']
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { response.destroy(); throw new Error('Film asset exceeds download size limit') }
    file = await fs.promises.open(destination, 'wx', 0o600); created = true
    let received = 0
    for await (const chunk of response) {
      if (controller.signal.aborted) throw new Error('Film download cancelled')
      received += chunk.length
      if (received > maxBytes) { response.destroy(); throw new Error('Film asset exceeds download size limit') }
      await file.writeFile(chunk)
    }
    if (received === 0 || (declared && received !== Number(declared))) throw new Error('Film download is empty or incomplete')
    completed = true
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
    controller.abort()
    await file?.close().catch(() => {})
    if (created && !completed) await fs.promises.unlink(destination).catch(() => {})
  }
}
