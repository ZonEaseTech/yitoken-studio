import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { isPublicAddress, validateFilmDownloadUrl, resolvePublicDownloadTarget, downloadFilmAsset } from './film-download'
import { inspectVideo, outputDimensions, validateFilmOutput, validateFilmRequest, FilmRenderManager, createFilmToolRunner } from './film-renderer'

const temporary: string[] = []
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yitoken-film-test-')); temporary.push(dir); return dir }
afterEach(() => { temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })) })

describe('film download trust boundary', () => {
  it('accepts public addresses only, including rejecting mapped/private IPv6', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '2001:db8::1', 'not-an-ip']) expect(isPublicAddress(ip)).toBe(false)
  })
  it('forbids non-HTTPS, credentials, key-query parameters and local hostnames', () => {
    expect(validateFilmDownloadUrl('https://cdn.example.com/video.mp4?expires=123&signature=public-media-signature').hostname).toBe('cdn.example.com')
    for (const url of ['http://cdn.example.com/a.mp4', 'file:///tmp/a.mp4', 'https://user:pass@cdn.example.com/a.mp4', 'https://localhost/a.mp4', 'https://127.0.0.1/a.mp4', 'https://cdn.example.com/a.mp4?api_key=fake', 'https://cdn.example.com/a.mp4?Authorization=fake', 'https://cdn.example.com/a.mp4#fragment']) expect(() => validateFilmDownloadUrl(url)).toThrow()
  })
  it('rejects mixed public/private DNS answers and preserves the verified IP for connection pinning', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]
    await expect(resolvePublicDownloadTarget('https://cdn.example.com/a.mp4', lookup)).rejects.toThrow('public')
    const target = await resolvePublicDownloadTarget('https://cdn.example.com/a.mp4', async () => [{ address: '8.8.8.8', family: 4 }])
    expect(target.address).toBe('8.8.8.8'); expect(target.family).toBe(4)
  })
})

describe('bounded HTTPS transport', () => {
  function mockResponse(status: number, bytes: Buffer, headers = {}) {
    const response = Readable.from([bytes]) as Readable & { statusCode: number; headers: Record<string, string> }
    response.statusCode = status; response.headers = headers
    const get = vi.spyOn(https, 'get').mockImplementation(((url: any, options: any, callback: any) => {
      const request = new EventEmitter()
      queueMicrotask(() => callback(response))
      return request
    }) as any)
    return { response, get }
  }
  it('pins the checked public IP and sends no authentication headers', async () => {
    const { get } = mockResponse(200, Buffer.from('synthetic-video'), { 'content-length': '15' })
    const file = path.join(temp(), 'download.mp4')
    await downloadFilmAsset('https://8.8.8.8/video.mp4', file, new AbortController().signal)
    expect(fs.readFileSync(file, 'utf8')).toBe('synthetic-video')
    const options = get.mock.calls[0][1] as any; const callback = vi.fn()
    options.lookup('8.8.8.8', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    expect(options.headers).toEqual({ Accept: 'video/*, application/octet-stream;q=0.8' })
  })
  it('writes every byte even if a low-level write would be partial', async () => {
    mockResponse(200, Buffer.from('synthetic-video'), { 'content-length': '15' })
    const realOpen = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args); const realWrite = handle.write.bind(handle)
      vi.spyOn(handle, 'write').mockImplementation((async (bytes: Buffer) => realWrite(bytes.subarray(0, Math.floor(bytes.length / 2)))) as any)
      return handle
    })
    const file = path.join(temp(), 'download.mp4')
    await downloadFilmAsset('https://8.8.8.8/video.mp4', file, new AbortController().signal)
    expect(fs.readFileSync(file, 'utf8')).toBe('synthetic-video')
  })
  it('rejects redirects and oversized bodies without creating output', async () => {
    for (const { status, bytes, headers } of [{ status: 302, bytes: Buffer.from('redirect'), headers: { location: 'https://127.0.0.1/private' } }, { status: 200, bytes: Buffer.alloc(20), headers: {} }, { status: 200, bytes: Buffer.from('x'), headers: { 'content-length': '999' } }]) {
      mockResponse(status, bytes, headers)
      const file = path.join(temp(), 'download.mp4')
      await expect(downloadFilmAsset('https://8.8.8.8/video.mp4', file, new AbortController().signal, 10)).rejects.toThrow()
      expect(fs.existsSync(file)).toBe(false)
    }
  })
  it('preserves an existing destination and observes cancellation without leaving partial downloads', async () => {
    mockResponse(200, Buffer.from('replacement'))
    const file = path.join(temp(), 'existing.mp4'); fs.writeFileSync(file, 'keep')
    await expect(downloadFilmAsset('https://8.8.8.8/video.mp4', file, new AbortController().signal)).rejects.toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('keep')
    const controller = new AbortController(); controller.abort()
    const cancelled = path.join(temp(), 'cancelled.mp4')
    await expect(downloadFilmAsset('https://8.8.8.8/video.mp4', cancelled, controller.signal)).rejects.toThrow('cancelled')
    expect(fs.existsSync(cancelled)).toBe(false)
  })
})

describe('film request / probe validation', () => {
  const request = { projectId: 'project-a', projectName: 'Synthetic Project', aspectRatio: '16:9', resolution: '720p', clips: [{ id: 'red', name: 'Red clip', sourceUrl: 'local-image://videos/red.mp4' }, { id: 'blue', name: 'Blue clip', sourceUrl: 'https://cdn.example.com/blue.mp4' }] }
  it('snapshots the ordered project request and rejects arbitrary local files/options', () => {
    const snapshot = validateFilmRequest(request)
    request.clips.reverse()
    expect(snapshot.clips.map((clip: { id: string }) => clip.id)).toEqual(['red', 'blue'])
    request.clips.reverse()
    for (const bad of [{ ...request, clips: [] }, { ...request, projectId: '' }, { ...request, resolution: '4k' }, { ...request, aspectRatio: 'square' }, { ...request, clips: [{ id: 'x', name: 'Invalid', sourceUrl: '/etc/passwd' }] }, { ...request, clips: Array.from({ length: 201 }, () => request.clips[0]) }]) expect(() => validateFilmRequest(bad)).toThrow()
    expect(outputDimensions('16:9', '720p')).toEqual({ width: 1280, height: 720 })
    expect(outputDimensions('9:16', '1080p')).toEqual({ width: 1080, height: 1920 })
  })
  it('uses actual video duration and tracks, never estimated five-second clip duration', () => {
    const video = { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, duration: '1.2', avg_frame_rate: '24/1' }
    expect(inspectVideo({ streams: [video, { codec_type: 'audio', codec_name: 'aac', duration: '1.2' }], format: { duration: '1.25', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } })).toMatchObject({ duration: 1.2, hasAudio: true, width: 640, height: 360 })
    expect(inspectVideo({ streams: [video], format: { duration: '1.25', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }).hasAudio).toBe(false)
    for (const probe of [{ streams: [], format: { duration: '5' } }, { streams: [{ ...video, duration: 'NaN' }], format: { duration: 'NaN' } }, { streams: [{ ...video, duration: '9999999' }], format: { duration: '9999999' } }, { streams: [video], format: { format_name: 'hls', duration: '1.2' } }]) expect(() => inspectVideo(probe)).toThrow()
  })
  it('rejects output until H264/AAC, dimensions, 30fps and summed real duration match', () => {
    const probe = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', duration: '2.6' }, { codec_type: 'audio', codec_name: 'aac', duration: '2.6' }], format: { duration: '2.65', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }
    expect(() => validateFilmOutput(probe, { width: 1280, height: 720 }, 2.6)).not.toThrow()
    for (const changed of [{ ...probe, streams: [probe.streams[0]] }, { ...probe, streams: [probe.streams[0], { ...probe.streams[1], duration: '99' }] }, { ...probe, streams: [{ ...probe.streams[0], codec_name: 'vp9' }, probe.streams[1]] }, { ...probe, streams: [{ ...probe.streams[0], width: 640 }, probe.streams[1]] }, { ...probe, streams: [{ ...probe.streams[0], avg_frame_rate: '24/1' }, probe.streams[1]] }, { ...probe, streams: [{ ...probe.streams[0], duration: '10' }, probe.streams[1]], format: { ...probe.format, duration: '10' } }]) expect(() => validateFilmOutput(changed, { width: 1280, height: 720 }, 2.6)).toThrow()
  })
})


describe('film job lifecycle', () => {
  const request = { projectId: 'project-a', projectName: 'Synthetic Film', aspectRatio: '16:9' as const, resolution: '720p' as const, clips: [{ id: 'red', name: 'Red', sourceUrl: 'local-image://videos/red.mp4' }] }
  function setup(chooseOutput?: () => Promise<string | null>, runTool?: any) {
    const root = temp(); const media = path.join(root, 'media'); fs.mkdirSync(path.join(media, 'videos'), { recursive: true }); fs.writeFileSync(path.join(media, 'videos', 'red.mp4'), 'synthetic-container')
    const output = path.join(root, 'film.mp4')
    const invoke = runTool || vi.fn(async (tool: string, args: string[]) => {
      if (tool === 'ffmpeg' && args[args.length - 1] !== '-') expect(args).toContain('-fs')
      if (args.includes('concat')) { const list = fs.readFileSync(args[args.indexOf('-i') + 1], 'utf8'); expect(list).toContain('duration 1.2') }
      if (tool === 'ffprobe') return JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '1.2', avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac', duration: '1.2' }], format: { duration: '1.2', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } })
      const final = args[args.length - 1]
      if (final !== '-') fs.writeFileSync(final, 'encoded-synthetic-video')
      return ''
    })
    const reveal = vi.fn()
    const manager = new FilmRenderManager({ mediaRoot: () => media, tools: { ffmpeg: '/fixed/ffmpeg', ffprobe: '/fixed/ffprobe' }, chooseOutput: chooseOutput || (async () => output), runTool: invoke, reveal })
    return { root, media, output, manager, invoke, reveal }
  }
  it('uses a fixed project snapshot, validates before atomic publication and never accepts renderer paths', async () => {
    const { manager, output, invoke, reveal } = setup()
    const started = await manager.start(request)
    expect(started.success).toBe(true); expect(started.job?.projectId).toBe('project-a')
    const job = await manager.whenFinished(started.job!.jobId)
    expect(job.phase).toBe('completed'); expect(job.progress).toBe(100); expect(job.outputPath).toBe(output)
    expect(invoke.mock.calls.some((call: any[]) => call[1].includes('-protocol_whitelist') && call[1].includes('file,pipe'))).toBe(true)
    expect(invoke.mock.calls[invoke.mock.calls.length - 1][1]).toContain('null')
    expect(fs.readFileSync(output, 'utf8')).toBe('encoded-synthetic-video')
    expect(manager.reveal(started.job!.jobId)).toEqual({ success: true }); expect(reveal).toHaveBeenCalledWith(output)
    expect(manager.reveal('/etc/passwd').success).toBe(false)
  })
  it('is busy during the native save dialog and freezes one media root for the whole snapshot', async () => {
    const root = temp(), first = path.join(root, 'media-a'), second = path.join(root, 'media-b')
    fs.mkdirSync(path.join(first, 'videos'), { recursive: true }); fs.mkdirSync(second)
    fs.writeFileSync(path.join(first, 'videos', 'red.mp4'), 'synthetic-source')
    let resolveDialog!: (value: string | null) => void, mediaRootCalls = 0
    const dialog = new Promise<string | null>(resolve => { resolveDialog = resolve })
    const manager = new FilmRenderManager({
      mediaRoot: () => mediaRootCalls++ === 0 ? first : second,
      tools: { ffmpeg: '/fixed/ffmpeg', ffprobe: '/fixed/ffprobe' }, chooseOutput: () => dialog, reveal: () => {},
      runTool: async (tool, args) => {
        if (tool === 'ffprobe') return JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: args[args.length - 1].endsWith('output.mp4') ? '2.4' : '1.2', avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac', duration: args[args.length - 1].endsWith('output.mp4') ? '2.4' : '1.2' }], format: { duration: args[args.length - 1].endsWith('output.mp4') ? '2.4' : '1.2', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } })
        if (args[args.length - 1] !== '-') fs.writeFileSync(args[args.length - 1], 'synthetic-encoded')
        return ''
      },
    })
    const pending = manager.start({ ...request, clips: [request.clips[0], { ...request.clips[0], id: 'second' }] })
    expect(manager.isBusy()).toBe(true)
    expect((await manager.start(request)).success).toBe(false)
    resolveDialog(path.join(root, 'frozen-root.mp4'))
    const started = await pending
    expect((await manager.whenFinished(started.job!.jobId)).phase).toBe('completed')
    expect(mediaRootCalls).toBe(1); expect(manager.isBusy()).toBe(false)
  })
  it('save-dialog cancellation and existing output do not start processing or overwrite user data', async () => {
    const cancelled = setup(async () => null)
    expect(await cancelled.manager.start(request)).toMatchObject({ success: false, cancelled: true })
    expect(cancelled.invoke).not.toHaveBeenCalled()
    const existing = setup(); fs.writeFileSync(existing.output, 'keep-existing')
    expect((await existing.manager.start(request)).success).toBe(false)
    expect(fs.readFileSync(existing.output, 'utf8')).toBe('keep-existing'); expect(existing.invoke).not.toHaveBeenCalled()
  })
  it('cancels the active child and cleans only its job directory, preserving sources', async () => {
    let running!: () => void; const began = new Promise<void>(resolve => { running = resolve })
    const fixture = setup(undefined, async (_tool: string, _args: string[], signal: AbortSignal) => {
      running()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      return ''
    })
    const started = await fixture.manager.start(request); await began
    expect(fixture.manager.cancel(started.job!.jobId).success).toBe(true)
    expect((await fixture.manager.whenFinished(started.job!.jobId)).phase).toBe('cancelled')
    expect(fs.existsSync(fixture.output)).toBe(false)
    expect(fs.readFileSync(path.join(fixture.media, 'videos', 'red.mp4'), 'utf8')).toBe('synthetic-container')
    expect(fs.readdirSync(fixture.root).some(name => name.startsWith('.yitoken-film-'))).toBe(false)
  })
  it('missing or corrupt inputs and decoder failures never claim completed or leave partial output', async () => {
    const missing = setup(); fs.unlinkSync(path.join(missing.media, 'videos', 'red.mp4'))
    const a = await missing.manager.start(request); expect((await missing.manager.whenFinished(a.job!.jobId)).phase).toBe('failed'); expect(fs.existsSync(missing.output)).toBe(false)
    const corrupt = setup(undefined, async () => { throw new Error('Input decode failed') })
    const b = await corrupt.manager.start(request); expect((await corrupt.manager.whenFinished(b.job!.jobId)).phase).toBe('failed'); expect(fs.existsSync(corrupt.output)).toBe(false)
  })
})


describe('real pinned FFmpeg full-film integration', () => {
  const binaryRoot = path.resolve('.cache/ffmpeg', `${process.platform}-${process.arch}`)
  const ffmpeg = path.join(binaryRoot, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const ffprobe = path.join(binaryRoot, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  it('normalizes actual non-five-second clips, retains audio, pads silence and preserves source order in two output shapes', async () => {
    if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) throw new Error('Integration requires root-prepared fixed FFmpeg tools')
    const root = temp(); const media = path.join(root, 'media'); const videos = path.join(media, 'videos'); fs.mkdirSync(videos, { recursive: true })
    const red = path.join(videos, 'red.mp4'), blue = path.join(videos, 'blue.mp4')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=red:s=320x240:r=24:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '1.2', red])
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=blue:s=352x288:r=17:d=1.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', blue])
    function probe(file: string) { return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString()) }
    const redSeconds = inspectVideo(probe(red)).duration, blueSeconds = inspectVideo(probe(blue)).duration
    expect(redSeconds).not.toBe(5); expect(blueSeconds).not.toBe(5)
    for (const shape of [{ aspectRatio: '16:9' as const, resolution: '720p' as const }, { aspectRatio: '9:16' as const, resolution: '1080p' as const }]) {
      const output = path.join(root, `film-${shape.resolution}.mp4`)
      const manager = new FilmRenderManager({ mediaRoot: () => media, tools: { ffmpeg, ffprobe }, chooseOutput: async () => output, reveal: () => {} })
      const started = await manager.start({ projectId: 'synthetic-a', projectName: 'Synthetic Film', ...shape, clips: [{ id: 'red', name: 'Red with original audio', sourceUrl: 'local-image://videos/red.mp4' }, { id: 'blue', name: 'Blue silent', sourceUrl: 'local-image://videos/blue.mp4' }] })
      const completed = await manager.whenFinished(started.job!.jobId)
      expect(completed.phase, completed.error).toBe('completed')
      const expectedSeconds = Math.ceil(redSeconds * 30) / 30 + Math.ceil(blueSeconds * 30) / 30
      const encoded = probe(output), dimensions = outputDimensions(shape.aspectRatio, shape.resolution)
      validateFilmOutput(encoded, dimensions, expectedSeconds)
      expect(Number(encoded.format.duration)).toBeCloseTo(expectedSeconds, 0)
      function pixel(time: number, x: number, y: number) {
        const bytes = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', output, '-vf', `crop=4:4:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'])
        const channels = [0, 0, 0]; for (let index = 0; index < bytes.length; index++) channels[index % 3] += bytes[index]
        return channels.map(value => value / (bytes.length / 3))
      }
      const first = pixel(0.5, dimensions.width / 2, dimensions.height / 2)
      const second = pixel(Math.ceil(redSeconds * 30) / 30 + 0.4, dimensions.width / 2, dimensions.height / 2)
      expect(first[0]).toBeGreaterThan(150); expect(first[2]).toBeLessThan(60)
      expect(second[2]).toBeGreaterThan(150); expect(second[0]).toBeLessThan(60)
      const border = shape.aspectRatio === '16:9' ? pixel(0.5, 0, dimensions.height / 2) : pixel(0.5, dimensions.width / 2, 0)
      expect(Math.max(...border)).toBeLessThan(10)
      function rms(time: number) {
        const pcm = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', output, '-t', '0.2', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
        let squares = 0; for (let offset = 0; offset + 4 <= pcm.length; offset += 4) squares += pcm.readFloatLE(offset) ** 2
        return Math.sqrt(squares / (pcm.length / 4))
      }
      expect(rms(0.3)).toBeGreaterThan(0.02)
      expect(rms(Math.ceil(redSeconds * 30) / 30 + 0.3)).toBeLessThan(0.001)
      expect(fs.readdirSync(root).some(name => name.startsWith('.yitoken-film-'))).toBe(false)
    }
    expect(fs.existsSync(red) && fs.existsSync(blue)).toBe(true)
  }, 120_000)
  it('keeps actual summed video/audio duration and late clip order after 40 short mixed-audio segments', async () => {
    const root = temp(), media = path.join(root, 'media'), videos = path.join(media, 'videos'); fs.mkdirSync(videos, { recursive: true })
    const red = path.join(videos, 'short-red.mp4'), blue = path.join(videos, 'short-blue.mp4')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=red:s=240x180:r=30:d=0.233333', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.233333', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '0.233333', red])
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=blue:s=256x192:r=17:d=0.27', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', blue])
    function probe(file: string) { return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString()) }
    const a = Math.ceil(inspectVideo(probe(red)).duration * 30) / 30, b = Math.ceil(inspectVideo(probe(blue)).duration * 30) / 30
    const output = path.join(root, 'many-short-clips.mp4')
    const clips = Array.from({ length: 40 }, (_item, index) => ({ id: `clip-${index}`, name: `Clip ${index}`, sourceUrl: `local-image://videos/${index % 2 === 0 ? 'short-red' : 'short-blue'}.mp4` }))
    const manager = new FilmRenderManager({ mediaRoot: () => media, tools: { ffmpeg, ffprobe }, chooseOutput: async () => output, reveal: () => {} })
    const started = await manager.start({ projectId: 'many-short', projectName: 'Short Mixed Clips', aspectRatio: '16:9', resolution: '720p', clips })
    const completed = await manager.whenFinished(started.job!.jobId)
    expect(completed.phase, completed.error).toBe('completed'); expect(completed.processedClips).toBe(40)
    const encoded = probe(output), expected = 20 * (a + b)
    validateFilmOutput(encoded, { width: 1280, height: 720 }, expected)
    const audio = encoded.streams.find((stream: any) => stream.codec_type === 'audio')
    expect(Math.abs(Number(audio.duration) - expected)).toBeLessThan(0.1)
    function sample(time: number) {
      const pixel = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', output, '-vf', 'crop=2:2:640:360,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'])
      const audio = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', output, '-t', '0.05', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
      let squares = 0; for (let offset = 0; offset + 4 <= audio.length; offset += 4) squares += audio.readFloatLE(offset) ** 2
      return { red: pixel[0], blue: pixel[2], rms: Math.sqrt(squares / (audio.length / 4)) }
    }
    const finalRed = sample(19 * (a + b) + 0.1), finalBlue = sample(19 * (a + b) + a + 0.1)
    expect(finalRed.red).toBeGreaterThan(150); expect(finalRed.rms).toBeGreaterThan(0.02)
    expect(finalBlue.blue).toBeGreaterThan(150); expect(finalBlue.rms).toBeLessThan(0.001)
  }, 120_000)

  it('cancels a real active FFmpeg process without publishing or deleting its source', async () => {
    const root = temp(), media = path.join(root, 'media'), videos = path.join(media, 'videos'); fs.mkdirSync(videos, { recursive: true })
    const input = path.join(videos, 'cancel.mp4'), output = path.join(root, 'cancelled.mp4')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=red:s=640x480:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', input])
    const bytes = fs.statSync(input).size, run = createFilmToolRunner({ ffmpeg, ffprobe })
    let jobId = '', startedChild = false
    const manager = new FilmRenderManager({
      mediaRoot: () => media, tools: { ffmpeg, ffprobe }, chooseOutput: async () => output, reveal: () => {},
      runTool: (tool, args, signal, cwd) => {
        const result = run(tool, args, signal, cwd)
        if (tool === 'ffmpeg' && args.some(value => value.endsWith('clip-0.mp4'))) { startedChild = true; queueMicrotask(() => manager.cancel(jobId)) }
        return result
      },
    })
    const start = await manager.start({ projectId: 'cancel-real', projectName: 'Cancel Fixture', aspectRatio: '9:16', resolution: '1080p', clips: [{ id: 'cancel', name: 'Cancel', sourceUrl: 'local-image://videos/cancel.mp4' }] })
    jobId = start.job!.jobId
    const finished = await manager.whenFinished(jobId)
    expect(startedChild).toBe(true); expect(finished.phase).toBe('cancelled')
    expect(fs.existsSync(output)).toBe(false); expect(fs.statSync(input).size).toBe(bytes)
    expect(fs.readdirSync(root).some(name => name.startsWith('.yitoken-film-'))).toBe(false)
  }, 30_000)

  it('preserves anamorphic display aspect ratio with SAR 2:1 instead of squeezing the coded square', async () => {
    const root = temp(), media = path.join(root, 'media'), videos = path.join(media, 'videos'); fs.mkdirSync(videos, { recursive: true })
    const input = path.join(videos, 'anamorphic.mp4'), output = path.join(root, 'anamorphic-film.mp4')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=red:s=320x320:r=24:d=0.8', '-vf', 'setsar=2/1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', input])
    const before = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', input]).toString())
    expect(before.streams[0].sample_aspect_ratio).toBe('2:1')
    const manager = new FilmRenderManager({ mediaRoot: () => media, tools: { ffmpeg, ffprobe }, chooseOutput: async () => output, reveal: () => {} })
    const started = await manager.start({ projectId: 'anamorphic', projectName: 'Anamorphic Fixture', aspectRatio: '16:9', resolution: '720p', clips: [{ id: 'anamorphic', name: 'SAR 2:1 Square Pixels', sourceUrl: 'local-image://videos/anamorphic.mp4' }] })
    const finished = await manager.whenFinished(started.job!.jobId)
    expect(finished.phase, finished.error).toBe('completed')
    function pixel(x: number, y: number) {
      return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '0.3', '-i', output, '-vf', `crop=4:4:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'])
    }
    // Coded square SAR=2 displays 2:1. In 16:9 it fills width with top/bottom black,
    // not a square with left/right bars introduced by blindly setting SAR to one.
    const leftCenter = pixel(4, 360), topCenter = pixel(640, 0)
    expect(leftCenter[0]).toBeGreaterThan(150)
    expect(Math.max(...topCenter)).toBeLessThan(10)
    const after = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output]).toString())
    expect(after.streams[0].sample_aspect_ratio).toBe('1:1')
    expect(after.streams[0].display_aspect_ratio).toBe('16:9')
  }, 30_000)

})
