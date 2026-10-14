// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
export type CredentialResult = { success: boolean; value?: string | null; error?: string }
export type EncryptionProvider = {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend?: () => string
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

export function createCredentialStore(file: string, encryption: EncryptionProvider, platform: string) {
  let recoveryRequired = false
  function requireEncryption() {
    if (!encryption.isEncryptionAvailable() || (platform === 'linux' && (!encryption.getSelectedStorageBackend || ['basic_text', 'unknown'].includes(encryption.getSelectedStorageBackend())))) throw new Error('Secure OS encryption unavailable')
  }
  function validate(value: unknown): asserts value is string {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 4 * 1024 * 1024) throw new Error('Invalid API configuration')
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || !parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) throw new Error('Invalid API configuration')
  }
  function read(): CredentialResult {
    try {
      if (!fs.existsSync(file)) return { success: true, value: null }
      requireEncryption()
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid credential file')
      const value = encryption.decryptString(fs.readFileSync(file))
      validate(value)
      recoveryRequired = false
      return { success: true, value }
    } catch {
      recoveryRequired = true
      return { success: false, error: '无法解密 API 配置；原加密文件已保留，请恢复系统密钥环后重启。' }
    }
  }
  function write(value: string): CredentialResult {
    const temporary = `${file}.${randomUUID()}.tmp`
    let created = false
    try {
      requireEncryption(); validate(value)
      // Also protect callers that attempt to write before reading an existing config.
      if (recoveryRequired || (fs.existsSync(file) && !read().success)) throw new Error('Credential recovery required')
      const encrypted = encryption.encryptString(value)
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.equals(Buffer.from(value))) throw new Error('Invalid encrypted output')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' })
      created = true
      fs.renameSync(temporary, file)
      return { success: true }
    } catch {
      return { success: false, error: 'API 配置未能加密保存，仅本次会话有效；原配置已保留。' }
    } finally {
      if (created && fs.existsSync(temporary)) { try { fs.unlinkSync(temporary) } catch { /* Retained ciphertext is not a plaintext fallback. */ } }
    }
  }
  function remove(): CredentialResult {
    try {
      requireEncryption()
      if (fs.existsSync(file)) {
        if (!read().success) throw new Error('Credential recovery required')
        fs.unlinkSync(file)
      }
      recoveryRequired = false
      return { success: true }
    } catch { return { success: false, error: '无法删除加密配置；原文件已保留。' } }
  }
  return { read, write, remove }
}
