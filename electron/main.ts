// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, safeStorage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { assertTrustedSender, containedStoragePath, isTrustedAppUrl, resolveMediaPath, trustedExternalUrl, trustedDevelopmentUrl } from './security-policy'
import { createCredentialStore } from './credential-store'
import { FilmRenderManager } from './film-renderer'
import { downloadFilmAsset, MAX_FILM_CLIP_BYTES } from './film-download'
import type { FilmRenderRequest } from '../src/types/film-render'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import packageMetadata from '../package.json'
import type { AvailableUpdateInfo, OpenExternalResult, UpdateCheckResult, UpdateManifest } from '../src/types/update'

// electron-vite 构建后的目录结构
//
// ├─┬ out
// │ ├─┬ main
// │ │ └── index.cjs
// │ ├─┬ preload
// │ │ └── index.cjs
// │ └─┬ renderer
// │   └── index.html
//
process.env.APP_ROOT = path.join(__dirname, '../..')

export const VITE_DEV_SERVER_URL = trustedDevelopmentUrl(process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL'], app.isPackaged)
export const MAIN_DIST = path.join(__dirname)
export const RENDERER_DIST = path.join(__dirname, '../renderer')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

type PackageUpdateConfig = {
  manifestUrl?: string
  defaultGithubUrl?: string
  defaultBaiduUrl?: string
  defaultBaiduCode?: string
}

type PackageMetadata = {
  updateConfig?: PackageUpdateConfig
}

const packageUpdateConfig = (packageMetadata as PackageMetadata).updateConfig ?? {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

const sanitizeExternalUrl = trustedExternalUrl

const selectedDirectories = new Set<string>()
const selectedDirectoryChannels = new Set([
  'storage-validate-data-dir', 'storage-link-data', 'storage-move-data', 'storage-export-data', 'storage-import-data',
  'storage-validate-project-dir', 'storage-link-project-data', 'storage-link-media-data',
  'storage-export-project-data', 'storage-import-project-data', 'storage-export-media-data', 'storage-import-media-data',
])
function appDocumentUrl() {
  return VITE_DEV_SERVER_URL || pathToFileURL(path.join(RENDERER_DIST, 'index.html')).toString()
}
const filmConflictingStorageChannels = new Set([
  'storage-move-data', 'storage-link-data', 'storage-import-data',
  'storage-link-project-data', 'storage-link-media-data',
  'storage-import-project-data', 'storage-import-media-data',
  'storage-update-config', 'storage-clear-cache',
])
let activeStorageMutations = 0
function trustedHandle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, win?.webContents, appDocumentUrl())
    if (filmConflictingStorageChannels.has(channel) && filmRenderManager?.isBusy()) throw new Error('整片合成进行中，暂不能迁移、导入、修改存储或清理缓存；请先完成或取消任务。')
    if (selectedDirectoryChannels.has(channel)) {
      const target = args[0]
      if (typeof target !== 'string' || !path.isAbsolute(target) || !selectedDirectories.has(fs.realpathSync(target))) throw new Error('Directory must be selected using the native application dialog')
    }
    if (!filmConflictingStorageChannels.has(channel)) return listener(event, ...args)
    activeStorageMutations += 1
    try { return await listener(event, ...args) }
    finally { activeStorageMutations -= 1 }
  })
}

function normalizeVersionParts(version: string) {
  return version
    .replace(/^v/i, '')
    .split('.')
    .map((part) => {
      const match = part.match(/\d+/)
      return match ? Number(match[0]) : 0
    })
}

function compareVersions(left: string, right: string) {
  const leftParts = normalizeVersionParts(left)
  const rightParts = normalizeVersionParts(right)
  const maxLength = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }

  return 0
}

function getUpdateManifestUrl() {
  return sanitizeExternalUrl(packageUpdateConfig.manifestUrl)
}

function getDefaultGithubUrl() {
  return sanitizeExternalUrl(packageUpdateConfig.defaultGithubUrl)
}

function getDefaultBaiduUrl() {
  return sanitizeExternalUrl(packageUpdateConfig.defaultBaiduUrl)
}

function getDefaultBaiduCode() {
  return isNonEmptyString(packageUpdateConfig.defaultBaiduCode)
    ? packageUpdateConfig.defaultBaiduCode.trim()
    : undefined
}

async function fetchUpdateManifest() {
  const manifestUrl = getUpdateManifestUrl()
  if (!manifestUrl) {
    throw new Error('未配置版本清单地址')
  }

  const requestUrl = new URL(manifestUrl)
  requestUrl.searchParams.set('_ts', Date.now().toString())

  const response = await net.fetch(requestUrl.toString(), { redirect: 'error' })
  if (!response.ok) {
    throw new Error(`版本清单请求失败 (${response.status})`)
  }

  const rawManifest = await response.json() as Partial<UpdateManifest>
  if (!isNonEmptyString(rawManifest.version)) {
    throw new Error('版本清单缺少有效的 version 字段')
  }

  return {
    version: rawManifest.version.trim(),
    releaseNotes: isNonEmptyString(rawManifest.releaseNotes)
      ? rawManifest.releaseNotes.trim()
      : isNonEmptyString(rawManifest.notes)
        ? rawManifest.notes.trim()
        : undefined,
    publishedAt: isNonEmptyString(rawManifest.publishedAt)
      ? rawManifest.publishedAt.trim()
      : undefined,
    githubUrl: sanitizeExternalUrl(rawManifest.githubUrl) ?? getDefaultGithubUrl(),
    baiduUrl: sanitizeExternalUrl(rawManifest.baiduUrl) ?? getDefaultBaiduUrl(),
    baiduCode: isNonEmptyString(rawManifest.baiduCode)
      ? rawManifest.baiduCode.trim()
      : getDefaultBaiduCode(),
  } satisfies UpdateManifest
}

async function resolveAvailableUpdate(currentVersion: string): Promise<AvailableUpdateInfo | null> {
  const manifest = await fetchUpdateManifest()
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return null
  }

  return {
    currentVersion,
    latestVersion: manifest.version,
    releaseNotes: manifest.releaseNotes,
    publishedAt: manifest.publishedAt,
    githubUrl: manifest.githubUrl,
    baiduUrl: manifest.baiduUrl,
    baiduCode: manifest.baiduCode,
  }
}

function createWindow() {
  win = new BrowserWindow({
    title: 'YITOKEN Studio',
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  // Existing prompt/name copy actions need only sanitized text writes, never clipboard reads.
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === win?.webContents && permission === 'clipboard-sanitized-write' && details.isMainFrame && isTrustedAppUrl(details.requestingUrl, appDocumentUrl()))
  })
  win.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    return contents === win?.webContents && permission === 'clipboard-sanitized-write' && details.isMainFrame && !!details.requestingUrl && isTrustedAppUrl(details.requestingUrl, appDocumentUrl())
  })
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.on('closed', () => selectedDirectories.clear())
  win.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = trustedExternalUrl(url)
    if (allowed) void shell.openExternal(allowed).catch(() => {})
    return { action: 'deny' }
  })
  const restrictNavigation = (event: { preventDefault: () => void }, url: string) => {
    if (isTrustedAppUrl(url, appDocumentUrl())) return
    event.preventDefault()
    const allowed = trustedExternalUrl(url)
    if (allowed) void shell.openExternal(allowed).catch(() => {})
  }
  win.webContents.on('will-navigate', restrictNavigation)
  win.webContents.on('will-redirect', restrictNavigation)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
// ==================== Storage Config ====================
type StorageConfig = {
  // Single base path for all data (projects + media)
  basePath?: string
  // Legacy fields (for migration)
  projectPath?: string
  mediaPath?: string
  autoCleanEnabled?: boolean
  autoCleanDays?: number
}

const DEFAULT_STORAGE_CONFIG: Required<StorageConfig> = {
  basePath: '',
  projectPath: '',
  mediaPath: '',
  autoCleanEnabled: false,
  autoCleanDays: 30,
}

const storageConfigPath = path.join(app.getPath('userData'), 'storage-config.json')
let storageConfig: StorageConfig = loadStorageConfig()
let autoCleanInterval: NodeJS.Timeout | null = null

function loadStorageConfig(): StorageConfig {
  try {
    if (fs.existsSync(storageConfigPath)) {
      const raw = fs.readFileSync(storageConfigPath, 'utf-8')
      const parsed = JSON.parse(raw) as StorageConfig
      return { ...DEFAULT_STORAGE_CONFIG, ...parsed }
    }
  } catch (error) {
    console.warn('Failed to load storage config:', error)
  }
  return { ...DEFAULT_STORAGE_CONFIG }
}

function saveStorageConfig() {
  try {
    fs.writeFileSync(storageConfigPath, JSON.stringify(storageConfig, null, 2), 'utf-8')
  } catch (error) {
    console.warn('Failed to save storage config:', error)
  }
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function normalizePath(inputPath: string) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath)
}

// Check if childPath is inside parentPath (subdirectory)
function isSubdirectory(parentPath: string, childPath: string): boolean {
  const normalizedParent = path.resolve(parentPath).toLowerCase() + path.sep
  const normalizedChild = path.resolve(childPath).toLowerCase() + path.sep
  return normalizedChild.startsWith(normalizedParent)
}

// Check if two paths are the same or one contains the other
function pathsConflict(source: string, dest: string): string | null {
  const normalizedSource = path.resolve(source).toLowerCase()
  const normalizedDest = path.resolve(dest).toLowerCase()
  
  if (normalizedSource === normalizedDest) {
    return null // Same path is OK, handled elsewhere
  }
  if (isSubdirectory(source, dest)) {
    return '目标路径不能是当前路径的子目录'
  }
  if (isSubdirectory(dest, source)) {
    return '当前路径不能是目标路径的子目录'
  }
  return null
}

// Get the base storage path (contains both projects and media)
function getStorageBasePath() {
  // Check new basePath first, then fall back to legacy projectPath parent
  const configured = storageConfig.basePath?.trim()
  if (configured) {
    return normalizePath(configured)
  }
  // Legacy migration: if projectPath exists, use its parent
  const legacyProject = storageConfig.projectPath?.trim()
  if (legacyProject) {
    return path.dirname(normalizePath(legacyProject))
  }
  return app.getPath('userData')
}

function getProjectDataRoot() {
  const base = containedStoragePath(getStorageBasePath(), 'projects')
  ensureDir(base)
  return base
}

function getMediaRoot() {
  const base = containedStoragePath(getStorageBasePath(), 'media')
  ensureDir(base)
  return base
}

function getCacheDirs() {
  const userData = app.getPath('userData')
  return [
    containedStoragePath(userData, 'Cache'),
    containedStoragePath(userData, 'Code Cache'),
    containedStoragePath(userData, 'GPUCache'),
  ]
}

async function getDirectorySize(dirPath: string): Promise<number> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += await getDirectorySize(fullPath)
      } else {
        const stat = await fs.promises.stat(fullPath)
        total += stat.size
      }
    }
    return total
  } catch {
    return 0
  }
}

async function copyDir(source: string, destination: string) {
  ensureDir(destination)
  await fs.promises.cp(source, destination, { recursive: true, force: true })
}

async function removeDir(dirPath: string) {
  await fs.promises.rm(dirPath, { recursive: true, force: true })
}

async function deleteOldFiles(dirPath: string, cutoffTime: number): Promise<number> {
  let cleared = 0
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        cleared += await deleteOldFiles(fullPath, cutoffTime)
        const remaining = await fs.promises.readdir(fullPath)
        if (remaining.length === 0) {
          await fs.promises.rmdir(fullPath).catch(() => {})
        }
      } else {
        const stat = await fs.promises.stat(fullPath)
        if (stat.mtimeMs < cutoffTime) {
          await fs.promises.unlink(fullPath).catch(() => {})
          cleared += stat.size
        }
      }
    }
  } catch {
    // ignore
  }
  return cleared
}

function scheduleAutoClean() {
  if (autoCleanInterval) {
    clearInterval(autoCleanInterval)
    autoCleanInterval = null
  }
  if (storageConfig.autoCleanEnabled) {
    const days = storageConfig.autoCleanDays || DEFAULT_STORAGE_CONFIG.autoCleanDays
    clearCache(days).catch(() => {})
    autoCleanInterval = setInterval(() => {
      clearCache(days).catch(() => {})
    }, 24 * 60 * 60 * 1000)
  }
}

async function clearCache(olderThanDays?: number): Promise<number> {
  const dirs = getCacheDirs()
  let cleared = 0
  if (olderThanDays && olderThanDays > 0) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
    for (const dir of dirs) {
      cleared += await deleteOldFiles(dir, cutoff)
    }
    return cleared
  }
  for (const dir of dirs) {
    cleared += await getDirectorySize(dir)
    await removeDir(dir).catch(() => {})
    ensureDir(dir)
  }
  return cleared
}

// Get user data path for storing images
const getImagesDir = (subDir: string) => {
  const imagesDir = containedStoragePath(getMediaRoot(), subDir)
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true })
  }
  return imagesDir
}

// The existing image/video cache shares the film transport's HTTPS/public-DNS boundary.
const downloadImage = (url: string, filePath: string): Promise<void> => {
  const video = /\.(?:mp4|webm|mov|avi|mkv)$/i.test(filePath)
  return downloadFilmAsset(url, filePath, new AbortController().signal, video ? MAX_FILM_CLIP_BYTES : 64 * 1024 * 1024, 'image/*, video/*, application/octet-stream;q=0.8')
}

type ImageHostUploadProvider = {
  name: string
  platform: string
  baseUrl?: string
  uploadPath?: string
  apiKeyParam?: string
  apiKeyHeader?: string
  apiKeyFormField?: string
  expirationParam?: string
  imageField?: string
  imagePayloadType?: 'base64' | 'file'
  nameField?: string
  staticFormFields?: Record<string, string>
  responseUrlField?: string
  responseDeleteUrlField?: string
}

type ImageHostUploadOptions = {
  name?: string
  expiration?: number
}

type ImageHostUploadRequest = {
  provider: ImageHostUploadProvider
  apiKey: string
  imageData: string
  options?: ImageHostUploadOptions
}

type ImageHostUploadResponse = {
  success: boolean
  url?: string
  deleteUrl?: string
  error?: string
}

function isHttpUrl(value: string) {
  return value.startsWith('http://') || value.startsWith('https://')
}

function resolveImageHostUploadUrl(provider: ImageHostUploadProvider) {
  const uploadPath = (provider.uploadPath || '').trim()
  if (uploadPath && isHttpUrl(uploadPath)) {
    return uploadPath
  }
  const baseUrl = (provider.baseUrl || '').trim().replace(/\/*$/, '')
  if (!baseUrl && !uploadPath) return ''
  if (!baseUrl && uploadPath) return ''
  if (!uploadPath) return baseUrl
  const normalizedPath = uploadPath.startsWith('/') ? uploadPath : `/${uploadPath}`
  return `${baseUrl}${normalizedPath}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getByPath(obj: unknown, objectPath?: string): unknown {
  if (!isRecord(obj) || !objectPath) return undefined
  return objectPath.split('.').reduce<unknown>((acc, key) => {
    if (!isRecord(acc)) return undefined
    return acc[key]
  }, obj)
}

function extractFirstHttpUrl(value: string): string | undefined {
  const match = value.match(/https?:\/\/[^\s"'<>]+/i)
  return match?.[0]
}

function getExtensionFromMimeType(mimeType?: string) {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    case 'image/bmp':
      return 'bmp'
    case 'image/avif':
      return 'avif'
    case 'image/png':
    default:
      return 'png'
  }
}

function getMimeTypeFromExtension(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
  }
  return mimeTypes[extension] || 'image/png'
}

function parseDataUrl(dataUrl: string): { buffer: Buffer, mimeType: string } | null {
  const matches = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s)
  if (!matches) return null
  const mimeType = matches[1] || 'image/png'
  const buffer = Buffer.from(matches[2], 'base64')
  if (buffer.length === 0) return null
  return { buffer, mimeType }
}

function resolveImageSourcePath(imagePath: string): string | null {
  if (imagePath.startsWith('local-image://') || imagePath.startsWith('local-video://') || imagePath.startsWith('file:') || path.isAbsolute(imagePath)) return resolveMediaPath(getMediaRoot(), imagePath)
  return null
}

async function fetchBuffer(url: string, timeoutMs: number = 45000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) throw new Error('Only HTTPS media requests are allowed')
    const response = await fetch(url, {
      redirect: 'error',
      headers: {
        Accept: 'image/*, */*;q=0.8',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (buffer.length === 0) {
      throw new Error('获取到的图片为空')
    }

    return {
      buffer,
      mimeType: response.headers.get('content-type') || 'image/png',
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`请求超时 (${Math.round(timeoutMs / 1000)}s)`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function readImageSource(imageData: string): Promise<{ buffer: Buffer, mimeType: string }> {
  if (isHttpUrl(imageData)) {
    return fetchBuffer(imageData)
  }

  const parsedDataUrl = parseDataUrl(imageData)
  if (parsedDataUrl) {
    return parsedDataUrl
  }

  const resolvedPath = resolveImageSourcePath(imageData)
  if (resolvedPath) {
    if (!fs.existsSync(resolvedPath)) {
      throw new Error('本地图片不存在')
    }
    const buffer = fs.readFileSync(resolvedPath)
    if (buffer.length === 0) {
      throw new Error('本地图片为空文件')
    }
    return {
      buffer,
      mimeType: getMimeTypeFromExtension(resolvedPath),
    }
  }

  const rawBuffer = Buffer.from(imageData, 'base64')
  if (rawBuffer.length === 0) {
    throw new Error('图片数据无效')
  }
  return {
    buffer: rawBuffer,
    mimeType: 'image/png',
  }
}

async function toUploadFilePayload(imageData: string, name?: string) {
  const { buffer, mimeType } = await readImageSource(imageData)
  const baseName = (name || 'upload').trim() || 'upload'
  const hasExtension = /\.[a-z0-9]{2,8}$/i.test(baseName)
  const filename = hasExtension ? baseName : `${baseName}.${getExtensionFromMimeType(mimeType)}`
  return {
    blob: new Blob([new Uint8Array(buffer)], { type: mimeType }),
    filename,
    mimeType,
  }
}

async function toBase64Payload(imageData: string) {
  if (imageData.startsWith('data:')) {
    const parsed = parseDataUrl(imageData)
    if (!parsed) {
      throw new Error('图片数据无效')
    }
    return parsed.buffer.toString('base64')
  }

  if (isHttpUrl(imageData) || imageData.startsWith('local-image://') || imageData.startsWith('file://') || path.isAbsolute(imageData)) {
    const { buffer } = await readImageSource(imageData)
    return buffer.toString('base64')
  }

  return imageData
}

async function uploadImageHostFromMain({
  provider,
  apiKey,
  imageData,
  options,
}: ImageHostUploadRequest): Promise<ImageHostUploadResponse> {
  try {
    const uploadUrl = resolveImageHostUploadUrl(provider)
    if (!uploadUrl) {
      return { success: false, error: '图床上传地址未配置' }
    }

    const fieldName = provider.imageField || 'image'
    const nameField = provider.nameField || 'name'
    const payloadType = provider.imagePayloadType || 'base64'
    const staticFormFields = provider.staticFormFields || {}

    const formData = new FormData()
    Object.entries(staticFormFields).forEach(([key, value]) => {
      formData.append(key, value)
    })
    if (provider.apiKeyFormField && apiKey) {
      formData.append(provider.apiKeyFormField, apiKey)
    }

    if (payloadType === 'file') {
      const { blob, filename } = await toUploadFilePayload(imageData, options?.name)
      formData.append(fieldName, blob, filename)
    } else {
      const base64Data = await toBase64Payload(imageData)
      formData.append(fieldName, base64Data)
    }

    if (options?.name) {
      formData.append(nameField, options.name)
    }

    const url = new URL(uploadUrl)
    if (url.protocol !== 'https:' || url.username || url.password) return { success: false, error: '图床上传必须使用 HTTPS 且不得在 URL 中包含凭据' }
    if (provider.apiKeyParam && apiKey) return { success: false, error: '不支持把图床密钥放入 URL，请使用请求头或表单字段' }
    if (provider.expirationParam && options?.expiration) {
      url.searchParams.set(provider.expirationParam, String(options.expiration))
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    }
    if (provider.apiKeyHeader && apiKey) {
      headers[provider.apiKeyHeader] = apiKey
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45000)

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        redirect: 'error',
        headers,
        body: formData,
        signal: controller.signal,
      })

      const text = await response.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }

      if (!response.ok) {
        const errorMessage = getByPath(data, 'error.message')
        const messageField = getByPath(data, 'message')
        const message = typeof errorMessage === 'string'
          ? errorMessage
          : typeof messageField === 'string'
            ? messageField
            : text || `上传失败: ${response.status}`
        return { success: false, error: message }
      }

      const urlField = getByPath(data, provider.responseUrlField || 'url')
      const deleteField = getByPath(data, provider.responseDeleteUrlField || 'delete_url')
      const trimmedText = text.trim()
      const extractedTextUrl = extractFirstHttpUrl(trimmedText)

      if (urlField) {
        return {
          success: true,
          url: typeof urlField === 'string' ? urlField : String(urlField),
          deleteUrl: deleteField ? (typeof deleteField === 'string' ? deleteField : String(deleteField)) : undefined,
        }
      }

      if (extractedTextUrl) {
        return { success: true, url: extractedTextUrl }
      }

      console.warn('[ImageHost/Main] Upload succeeded but no URL was detected in the response', {
        provider: provider.name,
        platform: provider.platform,
        // Do not log response bodies: providers can echo credential-bearing URLs.
      })
      return { success: false, error: `图床 ${provider.name} 上传成功但未返回 URL` }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: '上传超时，请稍后重试' }
      }
      return { success: false, error: error instanceof Error ? error.message : '上传失败' }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '上传失败' }
  }
}

// IPC handlers for image management
trustedHandle('save-image', async (_event, { url, category, filename }) => {
  try {
    const imagesDir = getImagesDir(category)
    const ext = path.extname(filename) || '.png'
    const safeName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`
    const filePath = containedStoragePath(imagesDir, safeName)
    const maxBytes = /\.(?:mp4|webm|mov|avi|mkv)$/i.test(safeName) ? MAX_FILM_CLIP_BYTES : 64 * 1024 * 1024
    if (typeof url !== 'string' || url.length > Math.ceil(maxBytes * 4 / 3) + 1024) throw new Error('Media exceeds storage size limit')
    
    // data: URL — 直接解码 base64 写入文件（canvas 切割产物）
    if (url.startsWith('data:')) {
      const matches = url.match(/^data:[^;]+;base64,(.+)$/s)
      if (!matches) {
        return { success: false, error: 'Invalid data URL format' }
      }
      const buffer = Buffer.from(matches[1], 'base64')
      if (buffer.length === 0 || buffer.length > maxBytes) {
        return { success: false, error: 'Decoded media is empty or exceeds storage size limit' }
      }
      fs.writeFileSync(filePath, buffer)
    } else {
      await downloadImage(url, filePath)
    }
    
    // Validate file was written successfully with non-zero size
    const stat = fs.statSync(filePath)
    if (stat.size === 0) {
      fs.unlinkSync(filePath) // Clean up empty file
      return { success: false, error: 'Saved file is 0 bytes' }
    }
    
    // Return local path that can be used in the app
    return { success: true, localPath: `local-image://${category}/${safeName}` }
  } catch (error) {
    console.error('Failed to save image:', error)
    return { success: false, error: String(error) }
  }
})

trustedHandle('get-image-path', async (_event, localPath: string) => {
  // Convert local-image://category/filename to actual file path
  const match = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
  if (!match) return null
  
  const [, category, filename] = match
  const filePath = containedStoragePath(getMediaRoot(), `${decodeURIComponent(category)}/${decodeURIComponent(filename)}`)
  
  if (fs.existsSync(filePath)) {
    // Windows: file:///H:/path/to/file.png (三斜杠 + 正斜杠)
    return `file:///${filePath.replace(/\\/g, '/')}`
  }
  return null
})

trustedHandle('delete-image', async (_event, localPath: string) => {
  const match = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
  if (!match) return false
  
  const [, category, filename] = match
  const filePath = containedStoragePath(getMediaRoot(), `${decodeURIComponent(category)}/${decodeURIComponent(filename)}`)
  
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    return true
  } catch {
    return false
  }
})

// Read local image as base64 (for AI API calls)
trustedHandle('read-image-base64', async (_event, localPath: string) => {
  try {
    let filePath: string
    
    // Handle local-image:// protocol
    const match = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
    if (match) {
      const [, category, filename] = match
      filePath = containedStoragePath(getMediaRoot(), `${decodeURIComponent(category)}/${decodeURIComponent(filename)}`)
    } else if (localPath.startsWith('file://')) {
      filePath = resolveMediaPath(getMediaRoot(), localPath)
    } else {
      filePath = resolveMediaPath(getMediaRoot(), localPath)
    }
    
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' }
    }
    
    const data = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    }
    const mimeType = mimeTypes[ext] || 'image/png'
    const base64 = `data:${mimeType};base64,${data.toString('base64')}`
    
    return { success: true, base64, mimeType, size: data.length }
  } catch (error) {
    console.error('Failed to read image:', error)
    return { success: false, error: String(error) }
  }
})

// Get absolute file path for a local-image:// URL
trustedHandle('get-absolute-path', async (_event, localPath: string) => {
  const match = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
  if (!match) return null
  
  const [, category, filename] = match
  const filePath = containedStoragePath(getMediaRoot(), `${decodeURIComponent(category)}/${decodeURIComponent(filename)}`)
  
  if (fs.existsSync(filePath)) {
    return filePath
  }
  return null
})

trustedHandle('image-host-upload', async (_event, payload: ImageHostUploadRequest) => {
  return uploadImageHostFromMain(payload)
})

// ==================== File Storage for App Data ====================
const getDataDir = () => {
  const dataDir = getProjectDataRoot()
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  return dataDir
}

trustedHandle('file-storage-get', async (_event, key: string) => {
  try {
    const root = getDataDir()
    containedStoragePath(root, key)
    const filePath = containedStoragePath(root, `${key}.json`)
    return fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // A failed read must not look like an empty/new project to persistence callers.
    console.warn('Project storage read failed; original data was preserved')
    throw new Error('项目数据读取失败；原文件未改动，请检查磁盘权限后重试。')
  }
})

trustedHandle('file-storage-set', async (_event, key: string, value: string) => {
  try {
    const root = getDataDir()
    containedStoragePath(root, key) // Validate the original key before appending an extension.
    const filePath = containedStoragePath(root, `${key}.json`)
    // Ensure parent directory exists (supports nested keys like _p/xxx/script)
    const parentDir = path.dirname(filePath)
    ensureDir(parentDir)
    fs.writeFileSync(filePath, value, 'utf-8')
    console.log(`Saved to file: ${filePath} (${Math.round(value.length / 1024)}KB)`)
    return true
  } catch (error) {
    console.error('Failed to write file storage:', error)
    return false
  }
})

trustedHandle('file-storage-remove', async (_event, key: string) => {
  try {
    const root = getDataDir()
    containedStoragePath(root, key) // Validate the original key before appending an extension.
    const filePath = containedStoragePath(root, `${key}.json`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    return true
  } catch (error) {
    console.error('Failed to remove file storage:', error)
    return false
  }
})

// Check if a storage key exists
trustedHandle('file-storage-exists', async (_event, key: string) => {
  try {
    const root = getDataDir()
    containedStoragePath(root, key) // Validate the original key before appending an extension.
    const filePath = containedStoragePath(root, `${key}.json`)
    return fs.existsSync(filePath)
  } catch {
    return false
  }
})

// List sub-directories under a directory prefix (used to discover project IDs under _p/)
trustedHandle('file-storage-list-dirs', async (_event, prefix: string) => {
  try {
    const dirPath = containedStoragePath(getDataDir(), prefix)
    if (!fs.existsSync(dirPath)) return []
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== '_migrated')
      .map(e => e.name)
  } catch {
    return []
  }
})

// List all JSON keys under a directory prefix
trustedHandle('file-storage-list', async (_event, prefix: string) => {
  try {
    const dirPath = containedStoragePath(getDataDir(), prefix)
    if (!fs.existsSync(dirPath)) return []
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => `${prefix}/${e.name.replace('.json', '')}`)
  } catch {
    return []
  }
})

// Remove an entire directory (for project deletion)
trustedHandle('file-storage-remove-dir', async (_event, prefix: string) => {
  try {
    const dirPath = containedStoragePath(getDataDir(), prefix)
    if (fs.existsSync(dirPath)) {
      await fs.promises.rm(dirPath, { recursive: true, force: true })
    }
    return true
  } catch (error) {
    console.error('Failed to remove directory:', error)
    return false
  }
})
// ==================== Storage Manager ====================
trustedHandle('storage-get-paths', async () => {
  return {
    basePath: getStorageBasePath(),
    projectPath: getProjectDataRoot(),
    mediaPath: getMediaRoot(),
    cachePath: path.join(app.getPath('userData'), 'Cache'),
  }
})

trustedHandle('storage-select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  const selected = fs.realpathSync(result.filePaths[0])
  selectedDirectories.add(selected)
  return selected
})

// Validate if a directory contains valid data (projects/ subfolder with .json files or _p/ dirs)
trustedHandle('storage-validate-data-dir', async (_event, dirPath: string) => {
  try {
    if (!dirPath) return { valid: false, error: '路径不能为空' }
    const target = normalizePath(dirPath)
    if (!fs.existsSync(target)) return { valid: false, error: '目录不存在' }
    
    // Check for projects/ subfolder with .json files or _p/ per-project dirs
    const projectsDir = path.join(target, 'projects')
    const mediaDir = path.join(target, 'media')
    
    let projectCount = 0
    let mediaCount = 0
    
    if (fs.existsSync(projectsDir)) {
      const files = await fs.promises.readdir(projectsDir)
      // Count root .json files (global stores)
      projectCount = files.filter(f => f.endsWith('.json')).length
      // Also count per-project directories under _p/
      const perProjectDir = path.join(projectsDir, '_p')
      if (fs.existsSync(perProjectDir)) {
        const projectDirs = await fs.promises.readdir(perProjectDir, { withFileTypes: true })
        const dirCount = projectDirs.filter(d => d.isDirectory() && !d.name.startsWith('.')).length
        if (dirCount > 0) projectCount = Math.max(projectCount, dirCount)
      }
    }
    
    if (fs.existsSync(mediaDir)) {
      const entries = await fs.promises.readdir(mediaDir)
      mediaCount = entries.length
    }
    
    if (projectCount === 0 && mediaCount === 0) {
      return { valid: false, error: '该目录不包含有效的数据（需要 projects/ 或 media/ 子目录）' }
    }
    
    return { valid: true, projectCount, mediaCount }
  } catch (error) {
    return { valid: false, error: String(error) }
  }
})

// Link to existing data directory (no data movement)
trustedHandle('storage-link-data', async (_event, dirPath: string) => {
  try {
    if (!dirPath) return { success: false, error: '路径不能为空' }
    const target = normalizePath(dirPath)
    if (!fs.existsSync(target)) return { success: false, error: '目录不存在' }
    
    // Validate it has data
    const projectsDir = path.join(target, 'projects')
    const mediaDir = path.join(target, 'media')
    
    const hasProjects = fs.existsSync(projectsDir)
    const hasMedia = fs.existsSync(mediaDir)
    
    if (!hasProjects && !hasMedia) {
      return { success: false, error: '该目录不包含有效的数据（需要 projects/ 或 media/ 子目录）' }
    }
    
    // Update config to point to this directory
    storageConfig.basePath = target
    storageConfig.projectPath = '' // Clear legacy
    storageConfig.mediaPath = ''   // Clear legacy
    saveStorageConfig()
    return { success: true, path: target }
  } catch (error) {
    console.error('Failed to link data:', error)
    return { success: false, error: String(error) }
  }
})

// Move all data to new location (single operation)
trustedHandle('storage-move-data', async (_event, newPath: string) => {
  try {
    if (!newPath) return { success: false, error: '路径不能为空' }
    const target = normalizePath(newPath)
    const currentBase = getStorageBasePath()
    
    if (currentBase === target) return { success: true, path: currentBase }
    
    // Check for path conflicts
    const conflictError = pathsConflict(currentBase, target)
    if (conflictError) {
      return { success: false, error: conflictError }
    }
    
    // Ensure target directories exist
    const targetProjectsDir = path.join(target, 'projects')
    const targetMediaDir = path.join(target, 'media')
    ensureDir(targetProjectsDir)
    ensureDir(targetMediaDir)
    
    // Move projects
    const currentProjectsDir = getProjectDataRoot()
    if (fs.existsSync(currentProjectsDir)) {
      const files = await fs.promises.readdir(currentProjectsDir)
      for (const file of files) {
        const src = path.join(currentProjectsDir, file)
        const dest = path.join(targetProjectsDir, file)
        await fs.promises.cp(src, dest, { recursive: true, force: true })
      }
    }
    
    // Move media
    const currentMediaDir = getMediaRoot()
    if (fs.existsSync(currentMediaDir)) {
      const files = await fs.promises.readdir(currentMediaDir)
      for (const file of files) {
        const src = path.join(currentMediaDir, file)
        const dest = path.join(targetMediaDir, file)
        await fs.promises.cp(src, dest, { recursive: true, force: true })
      }
    }
    
    // Update config
    storageConfig.basePath = target
    storageConfig.projectPath = '' // Clear legacy
    storageConfig.mediaPath = ''   // Clear legacy
    saveStorageConfig()
    
    // Clean up old directories (only if different from userData)
    const userData = app.getPath('userData')
    if (!currentProjectsDir.startsWith(userData)) {
      await removeDir(currentProjectsDir).catch(() => {})
    }
    if (!currentMediaDir.startsWith(userData)) {
      await removeDir(currentMediaDir).catch(() => {})
    }
    
    return { success: true, path: target }
  } catch (error) {
    console.error('Failed to move data:', error)
    return { success: false, error: String(error) }
  }
})

// Export all data
trustedHandle('storage-export-data', async (_event, targetPath: string) => {
  try {
    if (!targetPath) return { success: false, error: '路径不能为空' }
    const exportDir = path.join(
      normalizePath(targetPath),
      `moyin-data-${new Date().toISOString().replace(/[:.]/g, '-')}`
    )
    
    // Create export structure
    const exportProjectsDir = path.join(exportDir, 'projects')
    const exportMediaDir = path.join(exportDir, 'media')
    ensureDir(exportProjectsDir)
    ensureDir(exportMediaDir)
    
    // Copy projects
    await copyDir(getProjectDataRoot(), exportProjectsDir)
    // Copy media
    await copyDir(getMediaRoot(), exportMediaDir)
    
    return { success: true, path: exportDir }
  } catch (error) {
    console.error('Failed to export data:', error)
    return { success: false, error: String(error) }
  }
})

// Import all data (with backup for safety)
trustedHandle('storage-import-data', async (_event, sourcePath: string) => {
  try {
    if (!sourcePath) return { success: false, error: '路径不能为空' }
    const source = normalizePath(sourcePath)
    
    const sourceProjectsDir = path.join(source, 'projects')
    const sourceMediaDir = path.join(source, 'media')
    
    // Validate source has data
    const hasProjects = fs.existsSync(sourceProjectsDir)
    const hasMedia = fs.existsSync(sourceMediaDir)
    if (!hasProjects && !hasMedia) {
      return { success: false, error: '源目录不包含有效数据（需要 projects/ 或 media/ 子目录）' }
    }
    
    // Create temporary backup for rollback
    const backupDir = path.join(os.tmpdir(), `moyin-backup-${Date.now()}`)
    const currentProjectsDir = getProjectDataRoot()
    const currentMediaDir = getMediaRoot()
    
    try {
      // Backup existing data
      if (hasProjects && fs.existsSync(currentProjectsDir)) {
        const files = await fs.promises.readdir(currentProjectsDir)
        if (files.length > 0) {
          await copyDir(currentProjectsDir, path.join(backupDir, 'projects'))
        }
      }
      if (hasMedia && fs.existsSync(currentMediaDir)) {
        const files = await fs.promises.readdir(currentMediaDir)
        if (files.length > 0) {
          await copyDir(currentMediaDir, path.join(backupDir, 'media'))
        }
      }
      
      // Import new data
      if (hasProjects) {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(sourceProjectsDir, currentProjectsDir)
      }
      if (hasMedia) {
        await removeDir(currentMediaDir).catch(() => {})
        await copyDir(sourceMediaDir, currentMediaDir)
      }
      
      // Clear migration flag so migration re-evaluates imported data on next startup
      const migrationFlagPath = path.join(currentProjectsDir, '_p', '_migrated.json')
      if (fs.existsSync(migrationFlagPath)) {
        fs.unlinkSync(migrationFlagPath)
        console.log('Cleared migration flag for re-evaluation after import')
      }
      
      // Success - clean up backup
      await removeDir(backupDir).catch(() => {})
      return { success: true }
    } catch (importError) {
      // Rollback: restore from backup
      console.error('Import failed, rolling back:', importError)
      const backupProjectsDir = path.join(backupDir, 'projects')
      const backupMediaDir = path.join(backupDir, 'media')
      
      if (fs.existsSync(backupProjectsDir)) {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(backupProjectsDir, currentProjectsDir).catch(() => {})
      }
      if (fs.existsSync(backupMediaDir)) {
        await removeDir(currentMediaDir).catch(() => {})
        await copyDir(backupMediaDir, currentMediaDir).catch(() => {})
      }
      await removeDir(backupDir).catch(() => {})
      
      throw importError
    }
  } catch (error) {
    console.error('Failed to import data:', error)
    return { success: false, error: String(error) }
  }
})

// Legacy handlers (kept for backward compatibility but redirect to new ones)
trustedHandle('storage-validate-project-dir', async (_event, dirPath: string) => {
  // Redirect to new unified handler
  return ipcMain.emit('storage-validate-data-dir', null, dirPath)
})

trustedHandle('storage-link-project-data', async (_event, dirPath: string) => {
  // For legacy: assume dirPath is the projects folder, use parent as base
  const target = normalizePath(dirPath)
  const basePath = path.dirname(target)
  storageConfig.basePath = basePath
  storageConfig.projectPath = ''
  storageConfig.mediaPath = ''
  saveStorageConfig()
  return { success: true, path: basePath }
})

trustedHandle('storage-link-media-data', async (_event, dirPath: string) => {
  // For legacy: assume dirPath is the media folder, use parent as base
  const target = normalizePath(dirPath)
  const basePath = path.dirname(target)
  storageConfig.basePath = basePath
  storageConfig.projectPath = ''
  storageConfig.mediaPath = ''
  saveStorageConfig()
  return { success: true, path: basePath }
})

trustedHandle('storage-move-project-data', async () => {
  return { success: false, error: '请使用新的统一存储路径功能' }
})
trustedHandle('storage-move-media-data', async () => {
  return { success: false, error: '请使用新的统一存储路径功能' }
})

trustedHandle('storage-export-project-data', async (_event, targetPath: string) => {
  // Redirect to unified export
  try {
    if (!targetPath) return { success: false, error: '路径不能为空' }
    const exportDir = path.join(
      normalizePath(targetPath),
      `moyin-data-${new Date().toISOString().replace(/[:.]/g, '-')}`
    )
    ensureDir(path.join(exportDir, 'projects'))
    ensureDir(path.join(exportDir, 'media'))
    await copyDir(getProjectDataRoot(), path.join(exportDir, 'projects'))
    await copyDir(getMediaRoot(), path.join(exportDir, 'media'))
    return { success: true, path: exportDir }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

trustedHandle('storage-import-project-data', async (_event, sourcePath: string) => {
  try {
    if (!sourcePath) return { success: false, error: '路径不能为空' }
    const source = normalizePath(sourcePath)
    const projectsDir = path.join(source, 'projects')
    const mediaDir = path.join(source, 'media')

    const currentProjectsDir = getProjectDataRoot()
    const currentMediaDir = getMediaRoot()
    const backupDir = path.join(os.tmpdir(), `moyin-legacy-import-backup-${Date.now()}`)

    try {
      if (fs.existsSync(currentProjectsDir)) {
        const files = await fs.promises.readdir(currentProjectsDir)
        if (files.length > 0) {
          await copyDir(currentProjectsDir, path.join(backupDir, 'projects'))
        }
      }
      if (fs.existsSync(currentMediaDir)) {
        const files = await fs.promises.readdir(currentMediaDir)
        if (files.length > 0) {
          await copyDir(currentMediaDir, path.join(backupDir, 'media'))
        }
      }

      if (fs.existsSync(projectsDir)) {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(projectsDir, currentProjectsDir)
      } else {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(source, currentProjectsDir)
      }

      if (fs.existsSync(mediaDir)) {
        await removeDir(currentMediaDir).catch(() => {})
        await copyDir(mediaDir, currentMediaDir)
      }

      await removeDir(backupDir).catch(() => {})
      return { success: true }
    } catch (importError) {
      console.error('Legacy import failed, rolling back:', importError)
      const backupProjectsDir = path.join(backupDir, 'projects')
      const backupMediaDir = path.join(backupDir, 'media')

      if (fs.existsSync(backupProjectsDir)) {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(backupProjectsDir, currentProjectsDir).catch(() => {})
      }
      if (fs.existsSync(backupMediaDir)) {
        await removeDir(currentMediaDir).catch(() => {})
        await copyDir(backupMediaDir, currentMediaDir).catch(() => {})
      }
      await removeDir(backupDir).catch(() => {})

      throw importError
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

trustedHandle('storage-export-media-data', async (_event, targetPath: string) => {
  // Legacy: redirect to unified export
  try {
    if (!targetPath) return { success: false, error: '路径不能为空' }
    const exportDir = path.join(
      normalizePath(targetPath),
      `moyin-data-${new Date().toISOString().replace(/[:.]/g, '-')}`
    )
    ensureDir(path.join(exportDir, 'projects'))
    ensureDir(path.join(exportDir, 'media'))
    await copyDir(getProjectDataRoot(), path.join(exportDir, 'projects'))
    await copyDir(getMediaRoot(), path.join(exportDir, 'media'))
    return { success: true, path: exportDir }
  } catch (error) {
    console.error('Failed to export data:', error)
    return { success: false, error: String(error) }
  }
})

trustedHandle('storage-import-media-data', async (_event, sourcePath: string) => {
  try {
    if (!sourcePath) return { success: false, error: '路径不能为空' }
    const target = getMediaRoot()
    const source = normalizePath(sourcePath)
    if (source === target) return { success: true }

    const backupDir = path.join(os.tmpdir(), `moyin-media-import-backup-${Date.now()}`)

    try {
      if (fs.existsSync(target)) {
        const files = await fs.promises.readdir(target)
        if (files.length > 0) {
          await copyDir(target, backupDir)
        }
      }

      await removeDir(target)
      await copyDir(source, target)

      await removeDir(backupDir).catch(() => {})
      return { success: true }
    } catch (importError) {
      console.error('Media import failed, rolling back:', importError)
      if (fs.existsSync(backupDir)) {
        await removeDir(target).catch(() => {})
        await copyDir(backupDir, target).catch(() => {})
      }
      await removeDir(backupDir).catch(() => {})
      throw importError
    }
  } catch (error) {
    console.error('Failed to import media data:', error)
    return { success: false, error: String(error) }
  }
})

trustedHandle('storage-get-cache-size', async () => {
  const dirs = getCacheDirs()
  const details = await Promise.all(
    dirs.map(async (dirPath) => ({
      path: dirPath,
      size: await getDirectorySize(dirPath),
    }))
  )
  const total = details.reduce((sum, item) => sum + item.size, 0)
  return { total, details }
})

trustedHandle('storage-clear-cache', async (_event, options?: { olderThanDays?: number }) => {
  try {
    const clearedBytes = await clearCache(options?.olderThanDays)
    return { success: true, clearedBytes }
  } catch (error) {
    console.error('Failed to clear cache:', error)
    return { success: false, error: String(error) }
  }
})

trustedHandle('storage-update-config', async (_event, config: { autoCleanEnabled?: boolean; autoCleanDays?: number }) => {
  if (!config || typeof config !== 'object') throw new Error('Invalid storage configuration')
  if (typeof config.autoCleanEnabled === 'boolean') storageConfig.autoCleanEnabled = config.autoCleanEnabled
  if (typeof config.autoCleanDays === 'number' && Number.isInteger(config.autoCleanDays) && config.autoCleanDays >= 1 && config.autoCleanDays <= 3650) storageConfig.autoCleanDays = config.autoCleanDays
  saveStorageConfig()
  scheduleAutoClean()
  return true
})

trustedHandle('app-updater-get-current-version', async () => {
  return app.getVersion()
})

trustedHandle('app-updater-check', async (): Promise<UpdateCheckResult> => {
  const currentVersion = app.getVersion()
  try {
    const update = await resolveAvailableUpdate(currentVersion)
    return {
      success: true,
      currentVersion,
      hasUpdate: !!update,
      update,
    }
  } catch (error) {
    console.error('Failed to check updates:', error)
    return {
      success: false,
      currentVersion,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

trustedHandle('app-updater-open-link', async (_event, url: string): Promise<OpenExternalResult> => {
  const safeUrl = sanitizeExternalUrl(url)
  if (!safeUrl) {
    return { success: false, error: '无效下载链接' }
  }

  try {
    await shell.openExternal(safeUrl)
    return { success: true }
  } catch (error) {
    console.error('Failed to open external link:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

// ==================== File Export (Save Dialog) ====================
trustedHandle('save-file-dialog', async (_event, { localPath, defaultPath, filters }: { localPath: string, defaultPath: string, filters: { name: string, extensions: string[] }[] }) => {
  try {
    // Resolve the source file path
    let sourcePath: string | null = null
    
    // Handle local-image:// and local-video:// protocols
    const imageMatch = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
    const videoMatch = localPath.match(/^local-video:\/\/(.+)\/(.+)$/)
    
    if (imageMatch) {
      const [, category, filename] = imageMatch
      sourcePath = containedStoragePath(getMediaRoot(), `${decodeURIComponent(category)}/${decodeURIComponent(filename)}`)
    } else if (videoMatch) {
      const [, category, filename] = videoMatch
      sourcePath = containedStoragePath(getMediaRoot(), `${decodeURIComponent(category)}/${decodeURIComponent(filename)}`)
    } else if (localPath.startsWith('file://')) {
      sourcePath = resolveMediaPath(getMediaRoot(), localPath)
    } else {
      sourcePath = resolveMediaPath(getMediaRoot(), localPath)
    }
    
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return { success: false, error: 'Source file not found' }
    }
    
    // Show save dialog
    const result = await dialog.showSaveDialog({
      defaultPath: defaultPath,
      filters: filters,
    })
    
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }
    
    // Copy file to destination
    fs.copyFileSync(sourcePath, result.filePath)
    
    return { success: true, filePath: result.filePath }
  } catch (error) {
    console.error('Failed to save file:', error)
    return { success: false, error: String(error) }
  }
})

// ==================== Demo Project Seed ====================

/**
 * Get the path to bundled demo-data.
 * - Dev mode: {APP_ROOT}/demo-data/
 * - Production: {resourcesPath}/demo-data/
 */
function getDemoDataPath(): string {
  if (VITE_DEV_SERVER_URL) {
    return path.join(process.env.APP_ROOT!, 'demo-data')
  }
  return path.join(process.resourcesPath, 'demo-data')
}

/**
 * Recursively copy a directory.
 * Uses fs.cpSync which is available in Node 16.7+.
 */
function copyDirSync(src: string, dest: string) {
  fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false })
}

/**
 * Seed demo project data on first run.
 * Checks if moyin-project-store.json exists in the project data root.
 * If not, copies demo data (JSON + media) to the user's storage directory.
 */
function seedDemoProject() {
  const projectDataRoot = getProjectDataRoot()
  const marker = path.join(projectDataRoot, 'moyin-project-store.json')

  if (fs.existsSync(marker)) {
    // Not first run — project store already exists
    return
  }

  const demoPath = getDemoDataPath()
  const demoProjects = path.join(demoPath, 'projects')
  const demoMedia = path.join(demoPath, 'media')

  if (!fs.existsSync(demoProjects)) {
    console.warn('[Seed] Demo data not found at:', demoPath)
    return
  }

  console.log('[Seed] First run detected — seeding demo project...')

  try {
    // Copy project JSON files
    copyDirSync(demoProjects, projectDataRoot)
    console.log('[Seed] Copied project data to:', projectDataRoot)

    // Copy media files
    if (fs.existsSync(demoMedia)) {
      const mediaRoot = getMediaRoot()
      copyDirSync(demoMedia, mediaRoot)
      console.log('[Seed] Copied media files to:', mediaRoot)
    }

    console.log('[Seed] Demo project seeded successfully.')
  } catch (error) {
    console.error('[Seed] Failed to seed demo project:', error)
  }
}

// Register custom protocol for local images
protocol.registerSchemesAsPrivileged([{
  scheme: 'local-image',
  privileges: {
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    stream: true,
  }
}])

app.whenReady().then(() => {
  // Seed demo project on first run (before window creation)
  seedDemoProject()

  scheduleAutoClean()
  // Handle local-image:// protocol
  protocol.handle('local-image', async (request) => {
    try {
      // URL format: local-image://category/filename
      const url = new URL(request.url)
      const category = url.hostname
      const filename = decodeURIComponent(url.pathname.slice(1)) // Remove leading / and decode
      const filePath = containedStoragePath(getMediaRoot(), `${decodeURIComponent(category)}/${decodeURIComponent(filename)}`)
      
      // Read file directly
      const data = fs.readFileSync(filePath)
      
      // Determine MIME type based on extension
      const ext = path.extname(filename).toLowerCase()
      const mimeTypes: Record<string, string> = {
        // Images
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        // Videos
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
      }
      const mimeType = mimeTypes[ext] || 'application/octet-stream'
      
      return new Response(data, {
        headers: { 'Content-Type': mimeType, 'X-Content-Type-Options': 'nosniff' }
      })
    } catch (error) {
      console.error('Failed to load local image:', error)
      return new Response('Image not found', { status: 404 })
    }
  })
  
  createWindow()
})

// A fixed independent encrypted file: project export/move does not carry API credentials.
const credentials = createCredentialStore(path.join(app.getPath('userData'), 'api-config.enc'), safeStorage, process.platform)
trustedHandle('api-config-read', () => credentials.read())
trustedHandle('api-config-write', (_event, value: string) => credentials.write(value))
trustedHandle('api-config-remove', () => credentials.remove())


// No executable paths, output paths, command arguments or API headers cross film IPC.
let filmRenderManager: FilmRenderManager | undefined
function getFilmRenderManager() {
  if (filmRenderManager) return filmRenderManager
  const toolRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg')
    : path.join(process.env.APP_ROOT!, '.cache', 'ffmpeg', `${process.platform}-${process.arch}`)
  const extension = process.platform === 'win32' ? '.exe' : ''
  filmRenderManager = new FilmRenderManager({
    mediaRoot: getMediaRoot,
    tools: { ffmpeg: path.join(toolRoot, `ffmpeg${extension}`), ffprobe: path.join(toolRoot, `ffprobe${extension}`) },
    chooseOutput: async (request: FilmRenderRequest) => {
      const name = request.projectName.replace(/[\\/:*?"<>|\r\n]/g, '-').trim().slice(0, 80) || 'Film'
      const result = await dialog.showSaveDialog(win!, { title: '保存 YITOKEN 整片 MP4', defaultPath: `YITOKEN-${name}.mp4`, filters: [{ name: 'MP4 Video', extensions: ['mp4'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] })
      return result.canceled || !result.filePath ? null : result.filePath
    },
    reveal: file => shell.showItemInFolder(file),
  })
  return filmRenderManager
}
trustedHandle('film-render-start', (_event, request: FilmRenderRequest) => {
  if (activeStorageMutations > 0) return { success: false, error: '存储操作正在进行，请等待迁移、导入或缓存操作完成后再开始整片合成。' }
  return getFilmRenderManager().start(request)
})
trustedHandle('film-render-status', (_event, jobId: string) => getFilmRenderManager().status(jobId))
trustedHandle('film-render-cancel', (_event, jobId: string) => getFilmRenderManager().cancel(jobId))
trustedHandle('film-render-reveal', (_event, jobId: string) => getFilmRenderManager().reveal(jobId))
let filmShutdownComplete = false
app.on('before-quit', event => {
  if (!filmRenderManager || filmShutdownComplete) return
  event.preventDefault()
  filmRenderManager.shutdown().finally(() => { filmShutdownComplete = true; app.quit() })
})
