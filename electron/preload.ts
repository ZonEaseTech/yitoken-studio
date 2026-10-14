// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import { ipcRenderer, contextBridge } from 'electron'
import { isAllowedIpcChannel } from './ipc-policy'
import type { FilmRenderRequest } from '../src/types/film-render'

// No universal bridge: only existing app operations may cross this boundary.
const listeners = new Map<Function, (...args: any[]) => void>()
function requireChannel(operation: 'on' | 'off' | 'send' | 'invoke', channel: string) {
  if (!isAllowedIpcChannel(operation, channel)) throw new Error('IPC channel is not allowed')
}
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void) {
    requireChannel('on', channel)
    const previous = listeners.get(listener)
    if (previous) ipcRenderer.off(channel, previous)
    const wrapped = (_event: unknown, ...args: unknown[]) => listener(undefined, ...args)
    listeners.set(listener, wrapped)
    ipcRenderer.on(channel, wrapped)
  },
  off(channel: string, listener: (event: unknown, ...args: unknown[]) => void) {
    requireChannel('off', channel)
    const wrapped = listeners.get(listener)
    if (wrapped) { ipcRenderer.off(channel, wrapped); listeners.delete(listener) }
  },
  send(channel: string, ...args: unknown[]) {
    requireChannel('send', channel)
    ipcRenderer.send(channel, ...args)
  },
  invoke(channel: string, ...args: unknown[]) {
    requireChannel('invoke', channel)
    return ipcRenderer.invoke(channel, ...args)
  },
})
contextBridge.exposeInMainWorld('secureApiConfig', {
  read: () => ipcRenderer.invoke('api-config-read'),
  write: (value: string) => ipcRenderer.invoke('api-config-write', value),
  remove: () => ipcRenderer.invoke('api-config-remove'),
})

// Image storage API
contextBridge.exposeInMainWorld('imageStorage', {
  // Save image from URL to local storage
  saveImage: (url: string, category: string, filename: string) => 
    ipcRenderer.invoke('save-image', { url, category, filename }),
  
  // Get actual file path for a local-image:// URL
  getImagePath: (localPath: string) => 
    ipcRenderer.invoke('get-image-path', localPath),
  
  // Delete a locally stored image
  deleteImage: (localPath: string) => 
    ipcRenderer.invoke('delete-image', localPath),
  
  // Read local image as base64 (for AI API calls like video generation)
  readAsBase64: (localPath: string) => 
    ipcRenderer.invoke('read-image-base64', localPath),
  
  // Get absolute file path (for local video generation tools like FFmpeg)
  getAbsolutePath: (localPath: string) => 
    ipcRenderer.invoke('get-absolute-path', localPath),
})

// File storage API for app data (unlimited size)
contextBridge.exposeInMainWorld('fileStorage', {
  getItem: (key: string) => ipcRenderer.invoke('file-storage-get', key),
  setItem: (key: string, value: string) => ipcRenderer.invoke('file-storage-set', key, value),
  removeItem: (key: string) => ipcRenderer.invoke('file-storage-remove', key),
  exists: (key: string) => ipcRenderer.invoke('file-storage-exists', key),
  listKeys: (prefix: string) => ipcRenderer.invoke('file-storage-list', prefix),
  listDirs: (prefix: string) => ipcRenderer.invoke('file-storage-list-dirs', prefix),
  removeDir: (prefix: string) => ipcRenderer.invoke('file-storage-remove-dir', prefix),
})
// Storage manager API for paths, cache, import/export
contextBridge.exposeInMainWorld('storageManager', {
  getPaths: () => ipcRenderer.invoke('storage-get-paths'),
  selectDirectory: () => ipcRenderer.invoke('storage-select-directory'),
  // Unified storage operations (single base path)
  validateDataDir: (dirPath: string) => ipcRenderer.invoke('storage-validate-data-dir', dirPath),
  moveData: (newPath: string) => ipcRenderer.invoke('storage-move-data', newPath),
  linkData: (dirPath: string) => ipcRenderer.invoke('storage-link-data', dirPath),
  exportData: (targetPath: string) => ipcRenderer.invoke('storage-export-data', targetPath),
  importData: (sourcePath: string) => ipcRenderer.invoke('storage-import-data', sourcePath),
  // Cache
  getCacheSize: () => ipcRenderer.invoke('storage-get-cache-size'),
  clearCache: (options?: { olderThanDays?: number }) => ipcRenderer.invoke('storage-clear-cache', options),
  updateConfig: (config: { autoCleanEnabled?: boolean; autoCleanDays?: number }) =>
    ipcRenderer.invoke('storage-update-config', config),
})

// Electron API for native features
contextBridge.exposeInMainWorld('electronAPI', {
  saveFileDialog: (options: { localPath: string, defaultPath: string, filters: { name: string, extensions: string[] }[] }) =>
    ipcRenderer.invoke('save-file-dialog', options),
})

contextBridge.exposeInMainWorld('appUpdater', {
  getCurrentVersion: () => ipcRenderer.invoke('app-updater-get-current-version'),
  checkForUpdates: () => ipcRenderer.invoke('app-updater-check'),
  openExternalLink: (url: string) => ipcRenderer.invoke('app-updater-open-link', url),
})

contextBridge.exposeInMainWorld('imageHostUploader', {
  upload: (payload: {
    provider: {
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
    apiKey: string
    imageData: string
    options?: {
      name?: string
      expiration?: number
    }
  }) => ipcRenderer.invoke('image-host-upload', payload),
})


contextBridge.exposeInMainWorld('filmRenderer', {
  start: (request: FilmRenderRequest) => ipcRenderer.invoke('film-render-start', request),
  status: (jobId: string) => ipcRenderer.invoke('film-render-status', jobId),
  cancel: (jobId: string) => ipcRenderer.invoke('film-render-cancel', jobId),
  reveal: (jobId: string) => ipcRenderer.invoke('film-render-reveal', jobId),
})
