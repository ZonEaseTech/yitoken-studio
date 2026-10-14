import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { trustedExternalUrl, isTrustedAppUrl, assertTrustedSender, containedStoragePath, resolveMediaPath, trustedDevelopmentUrl } from './security-policy'
import { isAllowedIpcChannel } from './ipc-policy'
import { createCredentialStore } from './credential-store'
import { createSecureApiStorage } from '../src/lib/secure-api-storage'

const temporary: string[] = []
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yitoken-security-test-')); temporary.push(dir); return dir }
afterEach(() => { temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })) })

describe('desktop trust boundaries', () => {
  it('allows only HTTPS official links, without URL credentials or deceptive hostnames', () => {
    expect(trustedExternalUrl('https://yitoken.com.cn/download')).toBe('https://yitoken.com.cn/download')
    for (const value of ['http://yitoken.com.cn/update.json', 'https://yitoken.com.cn.evil.test/', 'https://evil.test/', 'https://user:pass@yitoken.com.cn/', 'file:///tmp/x', 'javascript:alert(1)', 'https://yitoken.com.cn:8443/']) expect(trustedExternalUrl(value)).toBeUndefined()
  })
  it('allows a development renderer only on loopback and never in packaged builds', () => {
    expect(trustedDevelopmentUrl('http://localhost:5173/', false)).toBe('http://localhost:5173/')
    expect(trustedDevelopmentUrl('http://127.0.0.1:5173/', false)).toBe('http://127.0.0.1:5173/')
    expect(trustedDevelopmentUrl('http://localhost:5173/', true)).toBeUndefined()
    for (const url of ['https://evil.test/', 'http://localhost.evil.test/', 'file:///etc/passwd', 'http://user:pass@localhost:5173/']) expect(trustedDevelopmentUrl(url, false)).toBeUndefined()
  })
  it('accepts only the application document and the top-level owning renderer', () => {
    const frame = { url: 'file:///app/index.html' }
    const owner = { mainFrame: frame }
    expect(isTrustedAppUrl('file:///app/index.html#settings', 'file:///app/index.html')).toBe(true)
    expect(isTrustedAppUrl('file:///etc/passwd', 'file:///app/index.html')).toBe(false)
    expect(isTrustedAppUrl('http://localhost:5173.evil.test/', 'http://localhost:5173/')).toBe(false)
    expect(() => assertTrustedSender({ sender: owner, senderFrame: frame }, owner, 'file:///app/index.html')).not.toThrow()
    expect(() => assertTrustedSender({ sender: owner, senderFrame: { url: frame.url } }, owner, frame.url)).toThrow()
    expect(() => assertTrustedSender({ sender: {}, senderFrame: frame }, owner, frame.url)).toThrow()
  })
  it('rejects unknown invoke/send/listen channels', () => {
    expect(isAllowedIpcChannel('invoke', 'file-storage-get')).toBe(true)
    expect(isAllowedIpcChannel('on', 'main-process-message')).toBe(true)
    expect(isAllowedIpcChannel('invoke', 'arbitrary-command')).toBe(false)
    expect(isAllowedIpcChannel('send', 'file-storage-get')).toBe(false)
    expect(isAllowedIpcChannel('on', 'api-config-read')).toBe(false)
  })
  it('preserves nested project keys while blocking traversal, root deletion and symlink escape', () => {
    const root = temp(); const outside = temp()
    expect(containedStoragePath(root, '_p/old-project/script.json')).toBe(path.join(root, '_p/old-project/script.json'))
    for (const key of ['../secret', '/etc/passwd', 'C:\\secret', 'a/../../secret', 'a\\..\\secret', '', '.', 'a\0b', '%2e%2e/secret']) expect(() => containedStoragePath(root, key)).toThrow()
    fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')
    expect(() => containedStoragePath(root, 'escape/secret.json')).toThrow()
    expect(resolveMediaPath(root, 'local-image://characters/test.png')).toBe(path.join(root, 'characters/test.png'))
    for (const value of ['local-image://characters/%2e%2e%2fsecret', 'local-image://../secret', 'file:///etc/passwd', '/etc/passwd']) expect(() => resolveMediaPath(root, value)).toThrow()
  })
})

describe('encrypted API configuration', () => {
  const value = JSON.stringify({ state: { providers: [{ apiKey: 'synthetic-test-key-not-real' }] }, version: 1 })
  function encryption() {
    const key = Buffer.alloc(32, 17), iv = Buffer.alloc(12, 19)
    return {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (plain: string) => { const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]) },
      decryptString: (bytes: Buffer) => { const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString() },
    }
  }
  it('persists only ciphertext in an independent fixed file and roundtrips the full state', () => {
    const file = path.join(temp(), 'api-config.enc'); const store = createCredentialStore(file, encryption(), 'linux')
    expect(store.write(value)).toEqual({ success: true })
    expect(fs.readFileSync(file).includes(Buffer.from('synthetic-test-key-not-real'))).toBe(false)
    expect(store.read()).toEqual({ success: true, value })
  })
  it('refuses unavailable/basic_text encryption and never writes a plaintext fallback', () => {
    for (const crypto of [{ ...encryption(), isEncryptionAvailable: () => false }, { ...encryption(), getSelectedStorageBackend: () => 'basic_text' }, { ...encryption(), encryptString: () => { throw new Error('broken') } }]) {
      const file = path.join(temp(), 'api-config.enc'); const store = createCredentialStore(file, crypto, 'linux')
      expect(store.write(value).success).toBe(false)
      expect(fs.existsSync(file)).toBe(false)
    }
  })
  it('does not overwrite an unreadable existing encrypted configuration', () => {
    const file = path.join(temp(), 'api-config.enc'); fs.writeFileSync(file, 'damaged-ciphertext')
    const store = createCredentialStore(file, encryption(), 'linux')
    expect(store.read().success).toBe(false)
    expect(store.write(value).success).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('damaged-ciphertext')
  })
  it('migrates legacy plaintext only after encrypted persistence succeeds', async () => {
    const values = new Map([['opencut-api-config', value]])
    const legacy = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key) } }
    const write = vi.fn(async () => ({ success: true }))
    const adapter = createSecureApiStorage({ bridge: { read: async () => ({ success: true, value: null }), write, remove: async () => ({ success: true }) }, legacy, onError: vi.fn() })
    expect(await adapter.getItem('opencut-api-config')).toBe(value)
    expect(write).toHaveBeenCalledWith(value)
    expect(values.has('opencut-api-config')).toBe(false)
  })
  it('retains the old value and new session value with explicit errors when encryption fails', async () => {
    const legacy = { getItem: () => value, removeItem: vi.fn() }; const onError = vi.fn()
    const adapter = createSecureApiStorage({ bridge: { read: async () => ({ success: true, value: null }), write: async () => ({ success: false }), remove: async () => ({ success: false }) }, legacy, onError })
    expect(await adapter.getItem('opencut-api-config')).toBe(value)
    expect(legacy.removeItem).not.toHaveBeenCalled()
    await adapter.setItem('opencut-api-config', 'new-session-only')
    expect(await adapter.getItem('opencut-api-config')).toBe('new-session-only')
    expect(onError).toHaveBeenCalled()
  })
  it('never overwrites a new user edit with a slow legacy hydration/migration', async () => {
    let release!: (value: { success: boolean; value: null }) => void
    const read = new Promise<{ success: boolean; value: null }>(resolve => { release = resolve })
    const persisted: string[] = []
    const adapter = createSecureApiStorage({
      bridge: { read: () => read, write: async data => { persisted.push(data); return { success: true } }, remove: async () => ({ success: true }) },
      legacy: { getItem: () => value, removeItem: vi.fn() },
    })
    const hydration = adapter.getItem('opencut-api-config'); await Promise.resolve(); await Promise.resolve()
    await adapter.setItem('opencut-api-config', 'new-user-edit')
    release({ success: true, value: null })
    expect(await hydration).toBe('new-user-edit')
    expect(persisted).toEqual(['new-user-edit'])
    expect(await adapter.getItem('opencut-api-config')).toBe('new-user-edit')
  })
  it('uses session memory only in web mode and serializes concurrent encrypted writes', async () => {
    const onError = vi.fn(); const web = createSecureApiStorage({ onError })
    await web.setItem('opencut-api-config', value)
    expect(await web.getItem('opencut-api-config')).toBe(value)
    expect(onError).toHaveBeenCalled()
    let release!: () => void; const first = new Promise<void>(resolve => { release = resolve }); const persisted: string[] = []
    const adapter = createSecureApiStorage({ bridge: { read: async () => ({ success: true, value: null }), write: async (data: string) => { if (data === 'first') await first; persisted.push(data); return { success: true } }, remove: async () => ({ success: true }) }, onError })
    const a = adapter.setItem('opencut-api-config', 'first'); const b = adapter.setItem('opencut-api-config', 'second'); release(); await Promise.all([a, b])
    expect(persisted).toEqual(['first', 'second'])
  })
})

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), bridges: new Map<string, any>(),
  userData: '', owner: null as any, windowOptions: null as any, selectPath: '',
  events: new Map<string, (...args: any[]) => void>(), protocolHandlers: new Map<string, any>(),
  saveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined })),
  permissionRequest: null as any, permissionCheck: null as any,
  external: vi.fn(async () => {}), invoke: vi.fn(async () => null), on: vi.fn(), off: vi.fn(),
}))
vi.mock('electron', async () => {
  const { pathToFileURL } = await import('node:url')
  return {
    app: { isPackaged: true, getPath: () => electronMock.userData, getVersion: () => '0.1.0', on: vi.fn(), quit: vi.fn(), whenReady: () => Promise.resolve() },
    BrowserWindow: class {
      static getAllWindows() { return [electronMock.owner] }
      webContents = { mainFrame: { url: '' }, on: (channel: string, listener: any) => electronMock.events.set(channel, listener), send: vi.fn(), setWindowOpenHandler: (handler: any) => electronMock.events.set('open-window', handler), session: { setPermissionRequestHandler: (handler: any) => { electronMock.permissionRequest = handler }, setPermissionCheckHandler: (handler: any) => { electronMock.permissionCheck = handler } } }
      constructor(options: any) { electronMock.windowOptions = options; electronMock.owner = this.webContents }
      on = vi.fn()
      loadFile(file: string) { this.webContents.mainFrame.url = pathToFileURL(file).toString() }
      loadURL(url: string) { this.webContents.mainFrame.url = url }
    },
    ipcMain: { handle: (channel: string, handler: any) => electronMock.handlers.set(channel, handler), emit: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: (scheme: string, handler: any) => electronMock.protocolHandlers.set(scheme, handler) },
    net: { fetch: vi.fn() }, shell: { openExternal: electronMock.external },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [electronMock.selectPath] }), showSaveDialog: electronMock.saveDialog },
    safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text' },
    contextBridge: { exposeInMainWorld: (name: string, bridge: any) => electronMock.bridges.set(name, bridge) },
    ipcRenderer: { invoke: electronMock.invoke, on: electronMock.on, off: electronMock.off, send: vi.fn() },
  }
})

describe('real main/preload wiring', () => {
  let data: string
  let destination: string
  beforeAll(async () => {
    // This synthetic test directory is not an operator profile or credential location.
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'yitoken-main-test-')); electronMock.userData = data
    fs.mkdirSync(path.join(data, 'projects')); fs.writeFileSync(path.join(data, 'projects', 'moyin-project-store.json'), '{}')
    Object.defineProperty(process, 'resourcesPath', { value: data, configurable: true })
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://evil.test/')
    vi.stubGlobal('__dirname', path.join(data, 'out', 'main'))
    await import('./main'); await Promise.resolve(); await import('./preload')
  })
  const event = () => ({ sender: electronMock.owner, senderFrame: electronMock.owner.mainFrame })
  it('packaged application ignores untrusted renderer environment overrides', () => {
    expect(electronMock.owner.mainFrame.url.startsWith('file:')).toBe(true)
  })
  it('rejects untrusted callers for every handler including updater and configuration', async () => {
    for (const handler of electronMock.handlers.values()) await expect(handler({ sender: {}, senderFrame: null })).rejects.toThrow('Untrusted')
  })
  it('rejects unchosen directories and runtime-config path injection while preserving native selection', async () => {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), 'yitoken-selected-test-'))
    await expect(electronMock.handlers.get('storage-move-data')!(event(), destination)).rejects.toThrow('selected')
    await electronMock.handlers.get('storage-update-config')!(event(), { basePath: destination, autoCleanEnabled: false })
    const paths = await electronMock.handlers.get('storage-get-paths')!(event())
    expect(paths.basePath).toBe(data)
    electronMock.selectPath = destination
    expect(await electronMock.handlers.get('storage-select-directory')!(event())).toBe(destination)
    expect((await electronMock.handlers.get('storage-move-data')!(event(), destination)).success).toBe(true)
  })
  it('keeps context isolation/sandbox enabled and blocks arbitrary files/navigation/external links', async () => {
    expect(electronMock.windowOptions.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
    expect(electronMock.windowOptions.title).toBe('YITOKEN Studio')
    const response = await electronMock.handlers.get('read-image-base64')!(event(), '/etc/passwd')
    expect(response.success).toBe(false)
    const preventDefault = vi.fn()
    electronMock.events.get('will-navigate')!({ preventDefault }, 'file:///etc/passwd')
    expect(preventDefault).toHaveBeenCalled()
    expect((await electronMock.handlers.get('app-updater-open-link')!(event(), 'http://yitoken.com.cn/update')).success).toBe(false)
    expect(electronMock.external).not.toHaveBeenCalled()
  })
  it('preserves trusted text copy but denies clipboard reads, camera and subframes', () => {
    const request = electronMock.permissionRequest
    const check = electronMock.permissionCheck
    const details = { isMainFrame: true, requestingUrl: electronMock.owner.mainFrame.url }
    const callback = vi.fn()
    request(electronMock.owner, 'clipboard-sanitized-write', callback, details)
    expect(callback).toHaveBeenLastCalledWith(true)
    expect(check(electronMock.owner, 'clipboard-sanitized-write', 'file://', details)).toBe(true)
    for (const permission of ['clipboard-read', 'media', 'notifications']) {
      request(electronMock.owner, permission, callback, details)
      expect(callback).toHaveBeenLastCalledWith(false)
    }
    request(electronMock.owner, 'clipboard-sanitized-write', callback, { ...details, isMainFrame: false })
    expect(callback).toHaveBeenLastCalledWith(false)
    expect(check(electronMock.owner, 'clipboard-sanitized-write', 'file://', { ...details, requestingUrl: 'file:///etc/passwd' })).toBe(false)
  })
  it('rejects symlinked cache roots without deleting user-chosen outside files', async () => {
    const outside = temp(); fs.writeFileSync(path.join(outside, 'keep.txt'), 'must-keep')
    fs.symlinkSync(outside, path.join(data, 'Cache'), 'dir')
    const result = await electronMock.handlers.get('storage-clear-cache')!(event(), { olderThanDays: 1 })
    expect(result.success).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('must-keep')
    fs.unlinkSync(path.join(data, 'Cache'))
  })
  it('preload rejects unknown channels and strips Electron event capabilities', async () => {
    const bridge = electronMock.bridges.get('ipcRenderer')
    expect(() => bridge.invoke('arbitrary-command')).toThrow('IPC')
    expect(() => bridge.send('arbitrary-command')).toThrow('IPC')
    const listener = vi.fn(); bridge.on('main-process-message', listener)
    const wrapped = electronMock.on.mock.calls[electronMock.on.mock.calls.length - 1][1]
    wrapped({ sender: { arbitraryPrivilege: true } }, 'hello')
    expect(listener).toHaveBeenCalledWith(undefined, 'hello')
    bridge.off('main-process-message', listener)
    expect(electronMock.off).toHaveBeenCalledWith('main-process-message', wrapped)
    expect(electronMock.bridges.get('secureApiConfig')).toMatchObject({ read: expect.any(Function), write: expect.any(Function), remove: expect.any(Function) })
  })
  it('exposes only the typed film job bridge and rejects unrelated reveal paths', async () => {
    const bridge = electronMock.bridges.get('filmRenderer')
    expect(bridge).toMatchObject({ start: expect.any(Function), status: expect.any(Function), cancel: expect.any(Function), reveal: expect.any(Function) })
    expect(isAllowedIpcChannel('invoke', 'film-render-start')).toBe(false)
    expect((await electronMock.handlers.get('film-render-status')!(event(), 'unknown-id')).success).toBe(false)
    expect((await electronMock.handlers.get('film-render-reveal')!(event(), '/etc/passwd')).success).toBe(false)
    expect((await electronMock.handlers.get('film-render-start')!(event(), { projectId: 'p', projectName: 'P', aspectRatio: '16:9', resolution: '720p', clips: [{ id: 'x', name: 'X', sourceUrl: 'local-image://videos/x.mp4' }] })).cancelled).toBe(true)
  })
  it('blocks only conflicting storage actions while a film native dialog is pending', async () => {
    let resolveDialog!: (value: { canceled: boolean; filePath: string | undefined }) => void
    electronMock.saveDialog.mockImplementationOnce(() => new Promise(resolve => { resolveDialog = resolve }))
    const pending = electronMock.handlers.get('film-render-start')!(event(), { projectId: 'busy', projectName: 'Busy Fixture', aspectRatio: '16:9', resolution: '720p', clips: [{ id: 'x', name: 'X', sourceUrl: 'local-image://videos/x.mp4' }] })
    await Promise.resolve(); await Promise.resolve()
    for (const channel of ['storage-move-data', 'storage-link-data', 'storage-import-data', 'storage-link-project-data', 'storage-link-media-data', 'storage-import-project-data', 'storage-import-media-data', 'storage-update-config', 'storage-clear-cache']) {
      await expect(electronMock.handlers.get(channel)!(event(), destination)).rejects.toThrow('整片合成')
    }
    expect((await electronMock.handlers.get('storage-get-paths')!(event())).basePath).toBe(destination)
    expect(await electronMock.handlers.get('file-storage-set')!(event(), '_p/busy-project/test', '{}')).toBe(true)
    expect(await electronMock.handlers.get('file-storage-get')!(event(), '_p/busy-project/test')).toBe('{}')
    resolveDialog({ canceled: true, filePath: undefined })
    expect((await pending).cancelled).toBe(true)
    expect(await electronMock.handlers.get('storage-update-config')!(event(), { autoCleanEnabled: false })).toBe(true)
  })
  it('refuses film start while an actual storage move is paused and clears the lock on failures', async () => {
    const target = temp(); electronMock.selectPath = target
    await electronMock.handlers.get('storage-select-directory')!(event())
    let release!: () => void, began!: () => void
    const paused = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { began = resolve })
    vi.spyOn(fs.promises, 'cp').mockImplementationOnce(async () => { began(); await paused; throw new Error('Synthetic storage copy cancellation') })
    const moving = electronMock.handlers.get('storage-move-data')!(event(), target)
    await entered
    const request = { projectId: 'blocked', projectName: 'Storage Busy', aspectRatio: '16:9', resolution: '720p', clips: [{ id: 'x', name: 'X', sourceUrl: 'local-image://videos/x.mp4' }] }
    const before = electronMock.saveDialog.mock.calls.length
    const blocked = await electronMock.handlers.get('film-render-start')!(event(), request)
    expect(blocked.success).toBe(false); expect(blocked.error).toContain('存储操作')
    expect(electronMock.saveDialog.mock.calls.length).toBe(before)
    release(); expect((await moving).success).toBe(false)
    expect((await electronMock.handlers.get('film-render-start')!(event(), request)).cancelled).toBe(true)
    await expect(electronMock.handlers.get('storage-update-config')!(event(), null)).rejects.toThrow('Invalid storage configuration')
    expect((await electronMock.handlers.get('film-render-start')!(event(), request)).cancelled).toBe(true)
  })
  it('real project storage IPC distinguishes missing data from EIO/EACCES and preserves the original file', async () => {
    const dir = path.join(destination, 'projects', '_p', 'read-failure'); fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'timeline.json'); fs.writeFileSync(file, '{"state":{"clips":[{"id":"keep"}]}}')
    const realRead = fs.readFileSync.bind(fs)
    let code = 'EIO'
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: any[]) => {
      if (args[0] === file) { const error = new Error('must-not-leak-sensitive-filename') as NodeJS.ErrnoException; error.code = code; throw error }
      return (realRead as any)(...args)
    }) as any)
    const get = electronMock.handlers.get('file-storage-get')!
    await expect(get(event(), '_p/read-failure/timeline')).rejects.toThrow('项目数据读取失败')
    code = 'EACCES'
    await expect(get(event(), '_p/read-failure/timeline')).rejects.not.toThrow('must-not-leak-sensitive-filename')
    read.mockRestore()
    expect(fs.readFileSync(file, 'utf8')).toBe('{"state":{"clips":[{"id":"keep"}]}}')
    expect(await get(event(), '_p/read-failure/missing')).toBeNull()
  })
  it('old save-image refuses private/credential-bearing URLs before opening any network connection', async () => {
    const get = vi.spyOn(https, 'get').mockImplementation((() => { throw new Error('Network must not open') }) as any)
    for (const url of ['https://127.0.0.1/private.png', 'https://8.8.8.8/image.png?api_key=synthetic-not-real']) {
      const result = await electronMock.handlers.get('save-image')!(event(), { url, category: 'characters', filename: 'image.png' })
      expect(result.success).toBe(false)
    }
    expect(get).not.toHaveBeenCalled()
  })
  it('preserves local-image rendering and nested project storage without permitting traversal', async () => {
    const media = path.join(destination, 'media', 'characters'); fs.mkdirSync(media, { recursive: true }); fs.writeFileSync(path.join(media, 'test.png'), 'synthetic-image')
    const protocol = electronMock.protocolHandlers.get('local-image')
    const image = await protocol({ url: 'local-image://characters/test.png' })
    expect(image.status).toBe(200); expect(await image.text()).toBe('synthetic-image')
    const get = electronMock.handlers.get('file-storage-get')!, set = electronMock.handlers.get('file-storage-set')!
    expect(await set(event(), '_p/project-id/script', '{"synthetic":"project"}')).toBe(true)
    expect(await get(event(), '_p/project-id/script')).toBe('{"synthetic":"project"}')
    expect(await set(event(), '../outside', 'must-not-write')).toBe(false)
    expect(await set(event(), '', 'must-not-write')).toBe(false)
    expect(fs.existsSync(path.join(destination, 'outside.json'))).toBe(false)
    expect((await protocol({ url: 'local-image://characters/%2e%2e%2f%2e%2e%2foutside' })).status).toBe(404)
  })
  afterAll(() => { fs.rmSync(data, { recursive: true, force: true }); if (destination) fs.rmSync(destination, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); delete (process as any).resourcesPath })

})
