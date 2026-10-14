// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
import type { StateStorage } from 'zustand/middleware'
import { toast } from 'sonner'
export type SecureConfigResult = { success: boolean; value?: string | null; error?: string }
export type SecureConfigBridge = {
  read: () => Promise<SecureConfigResult>
  write: (value: string) => Promise<SecureConfigResult>
  remove: () => Promise<SecureConfigResult>
}
type StorageOptions = {
  bridge?: SecureConfigBridge
  legacy?: Pick<Storage, 'getItem' | 'removeItem'>
  onError?: (message: string) => void
}
const CONFIG_NAME = 'opencut-api-config'
const SAVE_ERROR = 'API 配置未能加密保存，仅本次会话有效；原配置已保留。'

// Async adapter for createJSONStorage. Browser preview deliberately never persists API keys.
export function createSecureApiStorage({ bridge, legacy, onError = () => {} }: StorageOptions): StateStorage {
  let sessionValue: string | null | undefined
  let queue = Promise.resolve()
  function checkName(name: string) {
    if (name !== CONFIG_NAME) throw new Error('Unsupported secure configuration name')
  }
  function enqueue(operation: () => Promise<void>) {
    const next = queue.then(operation)
    queue = next.catch(() => {})
    return next
  }
  return {
    async getItem(name) {
      checkName(name)
      await queue
      if (sessionValue !== undefined) return sessionValue
      let result: SecureConfigResult = { success: false }
      if (bridge) {
        try { result = await bridge.read() } catch { /* Surface failure below, without logging any configuration. */ }
      }
      // Async hydration must not overwrite a user edit made while IPC was pending.
      if (sessionValue !== undefined) return sessionValue
      if (result.success && result.value != null) {
        sessionValue = result.value
        // A successful decrypted read proves an encrypted copy exists.
        try { legacy?.removeItem(name) } catch { onError('加密配置可用，但旧明文配置清理失败，请检查浏览器存储权限。') }
        return sessionValue
      }
      let old: string | null = null
      try { old = legacy?.getItem(name) ?? null } catch { onError('无法读取旧 API 配置；旧配置未删除。') }
      sessionValue = old
      if (old != null && result.success && bridge) {
        let saved: SecureConfigResult = { success: false }
        const legacyValue = old
        await enqueue(async () => {
          try { saved = await bridge.write(legacyValue) } catch { /* Never delete the legacy value when encryption fails. */ }
        })
        if (saved.success) {
          try { legacy?.removeItem(name) } catch { onError('加密配置已保存，但旧明文配置清理失败，请检查浏览器存储权限。') }
        } else onError(saved.error || SAVE_ERROR)
      } else if (!result.success || !bridge) onError(result.error || SAVE_ERROR)
      return sessionValue
    },
    setItem(name, value) {
      checkName(name)
      sessionValue = value
      return enqueue(async () => {
        let result: SecureConfigResult = { success: false }
        try { if (bridge) result = await bridge.write(value) } catch { /* Keep session and legacy data. */ }
        if (!result.success) onError(result.error || SAVE_ERROR)
        else { try { legacy?.removeItem(name) } catch { onError('加密配置已保存，但旧明文配置清理失败。') } }
      })
    },
    removeItem(name) {
      checkName(name)
      sessionValue = null
      return enqueue(async () => {
        let result: SecureConfigResult = { success: false }
        try { if (bridge) result = await bridge.remove() } catch { /* Preserve existing encrypted and legacy files. */ }
        if (!result.success) onError(result.error || '删除 API 配置失败；旧配置已保留。')
        else { try { legacy?.removeItem(name) } catch { onError('旧明文 API 配置清理失败。') } }
      })
    },
  }
}

function browserOptions(): StorageOptions {
  if (typeof window === 'undefined') return {}
  let legacy: StorageOptions['legacy']
  try { legacy = window.localStorage } catch { /* Storage-disabled environments remain session-only. */ }
  return {
    bridge: window.secureApiConfig,
    legacy,
    onError: message => toast.error(message, { id: 'api-config-secure-storage', duration: 10000 }),
  }
}
export const secureApiStorage = createSecureApiStorage(browserOptions())
