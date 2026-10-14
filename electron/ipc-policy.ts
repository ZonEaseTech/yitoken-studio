// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
const invokeChannels = new Set([
  'save-image', 'get-image-path', 'delete-image', 'read-image-base64', 'get-absolute-path',
  'image-host-upload', 'file-storage-get', 'file-storage-set', 'file-storage-remove',
  'file-storage-exists', 'file-storage-list', 'file-storage-list-dirs', 'file-storage-remove-dir',
  'storage-get-paths', 'storage-select-directory', 'storage-validate-data-dir', 'storage-move-data',
  'storage-link-data', 'storage-export-data', 'storage-import-data', 'storage-get-cache-size',
  'storage-clear-cache', 'storage-update-config', 'save-file-dialog',
  'app-updater-get-current-version', 'app-updater-check', 'app-updater-open-link',
])
export function isAllowedIpcChannel(operation: 'invoke' | 'send' | 'on' | 'off', channel: string): boolean {
  if (operation === 'invoke') return invokeChannels.has(channel)
  if (operation === 'on' || operation === 'off') return channel === 'main-process-message'
  return false // No renderer-to-main fire-and-forget messages are required.
}
