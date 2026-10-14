// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Downloads/help/update manifests must remain on the operator's HTTPS site.
export function trustedExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['yitoken.com.cn', 'www.yitoken.com.cn'].includes(url.hostname) || url.username || url.password || url.port) return undefined
    return url.toString()
  } catch { return undefined }
}

export function isTrustedAppUrl(value: string, appUrl: string): boolean {
  try {
    const candidate = new URL(value), expected = new URL(appUrl)
    candidate.hash = ''; expected.hash = ''
    return candidate.href === expected.href
  } catch { return false }
}

type Frame = { url: string }
type Owner = { mainFrame: Frame }
export function assertTrustedSender(event: { sender: unknown; senderFrame: Frame | null }, owner: Owner | null | undefined, appUrl: string): void {
  if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame || !event.senderFrame || !isTrustedAppUrl(event.senderFrame.url, appUrl)) throw new Error('Untrusted application IPC sender')
}

// Nested project keys are supported, but absolute paths, encoded segments and symlinks are not.
export function containedStoragePath(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative.length === 0 || relative.length > 1024 || /[\\\0:%]/.test(relative) || path.isAbsolute(relative)) throw new Error('Invalid storage path')
  const segments = relative.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Invalid storage path')
  const base = fs.realpathSync(root)
  const destination = path.resolve(base, ...segments)
  const boundary = path.relative(base, destination)
  if (!boundary || boundary.startsWith(`..${path.sep}`) || boundary === '..' || path.isAbsolute(boundary)) throw new Error('Storage path escapes its root')
  let current = base
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not allowed in storage paths')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return destination
}

export function resolveMediaPath(root: string, value: string): string {
  if (typeof value !== 'string') throw new Error('Invalid media path')
  const match = value.match(/^local-(?:image|video):\/\/([^/]+)\/(.+)$/)
  if (match) return containedStoragePath(root, `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`)
  const candidate = value.startsWith('file:') ? fileURLToPath(value) : value
  if (!path.isAbsolute(candidate)) throw new Error('Invalid media path')
  const relative = path.relative(fs.realpathSync(root), path.resolve(candidate))
  return containedStoragePath(root, relative.split(path.sep).join('/'))
}

export function trustedDevelopmentUrl(value: unknown, packaged: boolean): string | undefined {
  if (packaged || typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) return undefined
    return url.toString()
  } catch { return undefined }
}
