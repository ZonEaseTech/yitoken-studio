// YITOKEN changes: fixed-tool, bounded, project-snapshot local MP4 assembly.
// Licensed under AGPL-3.0-or-later. See LICENSE and NOTICE.md.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolveMediaPath } from './security-policy'
import type { FilmRenderActionResult, FilmRenderPhase, FilmRenderResult, FilmRenderStatus, FilmRenderRequest } from '../src/types/film-render'
import { downloadFilmAsset, MAX_FILM_CLIP_BYTES, validateFilmDownloadUrl } from './film-download'
export const FILM_LIMITS = { clips: 200, clipSeconds: 600, totalSeconds: 7200, totalBytes: 2 * 1024 * 1024 * 1024 }

type ProbeStream = { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string; disposition?: { attached_pic?: number } }
export type FilmProbe = { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } }
export type Dimensions = { width: number; height: number }
export function outputDimensions(ratio: FilmRenderRequest['aspectRatio'], resolution: FilmRenderRequest['resolution']): Dimensions {
  const landscape = resolution === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
  return ratio === '9:16' ? { width: landscape.height, height: landscape.width } : landscape
}
export function validateFilmRequest(value: unknown): FilmRenderRequest {
  const request = value as FilmRenderRequest
  if (!request || typeof request !== 'object' || typeof request.projectId !== 'string' || !request.projectId.trim() || request.projectId.length > 200 || typeof request.projectName !== 'string' || request.projectName.length > 500 || !['16:9', '9:16'].includes(request.aspectRatio) || !['720p', '1080p'].includes(request.resolution) || !Array.isArray(request.clips) || request.clips.length === 0 || request.clips.length > FILM_LIMITS.clips) throw new Error('Invalid film project snapshot or clip count')
  const clips = request.clips.map(clip => {
    if (!clip || typeof clip.id !== 'string' || !clip.id || clip.id.length > 200 || typeof clip.name !== 'string' || clip.name.length > 500 || typeof clip.sourceUrl !== 'string') throw new Error('Invalid film clip')
    if (clip.sourceUrl.startsWith('local-image://')) {
      if (!/^local-image:\/\/[a-zA-Z0-9_-]+\/[^/\\]+\.(?:mp4|mov|webm|mkv|avi)$/i.test(clip.sourceUrl) || clip.sourceUrl.length > 1024 || /[\0]/.test(clip.sourceUrl)) throw new Error('Film requires a stored video container')
    } else validateFilmDownloadUrl(clip.sourceUrl)
    return { id: clip.id, name: clip.name, sourceUrl: clip.sourceUrl, ...(typeof clip.mediaId === 'string' && clip.mediaId.length <= 200 ? { mediaId: clip.mediaId } : {}) }
  })
  return { projectId: request.projectId, projectName: request.projectName, aspectRatio: request.aspectRatio, resolution: request.resolution, clips }
}
export function inspectVideo(probe: FilmProbe, maximumSeconds = FILM_LIMITS.clipSeconds) {
  const stream = probe.streams?.find(item => item.codec_type === 'video' && !item.disposition?.attached_pic)
  const format = probe.format?.format_name || ''
  if (!stream || !/^(?:mov,mp4,m4a,3gp,3g2,mj2|matroska,webm|avi)$/.test(format) || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || !stream.width || !stream.height || stream.width > 8192 || stream.height > 8192) throw new Error('Input is not a supported bounded video container')
  const duration = Number(stream.duration ?? probe.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0 || duration > maximumSeconds) throw new Error('Video duration is missing or exceeds the film limit')
  return { duration, hasAudio: !!probe.streams?.some(item => item.codec_type === 'audio'), width: stream.width, height: stream.height, stream }
}
export function validateFilmOutput(probe: FilmProbe, dimensions: Dimensions, expectedSeconds: number): void {
  const video = inspectVideo(probe, FILM_LIMITS.totalSeconds + 1)
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio')
  const [numerator, denominator] = (video.stream.avg_frame_rate || '').split('/').map(Number)
  const fps = numerator / (denominator || 1)
  const formatDuration = Number(probe.format?.duration)
  const audioDuration = Number(audio?.duration)
  if (video.stream.codec_name !== 'h264' || audio?.codec_name !== 'aac' || !Number.isFinite(audioDuration) || audioDuration <= 0 || Math.abs(audioDuration - expectedSeconds) > 0.25 || video.width !== dimensions.width || video.height !== dimensions.height || Math.abs(fps - 30) > 0.001 || Math.abs(video.duration - expectedSeconds) > 0.2 || !Number.isFinite(formatDuration) || Math.abs(formatDuration - expectedSeconds) > 0.25) throw new Error('Encoded film does not match codec, dimensions, fps or duration requirements')
}


type ToolName = 'ffmpeg' | 'ffprobe'
type RunTool = (tool: ToolName, args: string[], signal: AbortSignal, cwd: string) => Promise<string>
type ManagerOptions = {
  mediaRoot: () => string
  tools: { ffmpeg: string; ffprobe: string }
  chooseOutput: (request: FilmRenderRequest) => Promise<string | null>
  reveal: (file: string) => void
  runTool?: RunTool
  download?: typeof downloadFilmAsset
}
type Job = { mediaRoot: string; settled: boolean; status: FilmRenderStatus; request: FilmRenderRequest; output: string; controller: AbortController; finished: Promise<FilmRenderStatus> }

export function createFilmToolRunner(tools: ManagerOptions['tools']): RunTool {
  return (tool, args, signal, cwd) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Film render cancelled')); return }
    const executable = tools[tool]
    if (!path.isAbsolute(executable) || !fs.existsSync(executable) || fs.lstatSync(executable).isSymbolicLink()) { reject(new Error('Bundled video tools are unavailable')); return }
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stdoutBytes = 0, stderrBytes = 0
    let stopped = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      stopped = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500)
      killTimer.unref()
    }
    const timeout = setTimeout(stop, tool === 'ffprobe' ? 120_000 : 900_000)
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 8 * 1024 * 1024) stop()
      else stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) stop() })
    child.once('error', () => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', stop)
      reject(new Error('Bundled video tool could not start'))
    })
    child.once('close', code => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', stop)
      if (signal.aborted || stopped) reject(new Error('Film video tool cancelled or exceeded its resource limit'))
      else if (code !== 0) reject(new Error(`Video ${tool === 'ffprobe' ? 'inspection' : 'encoding/decoding'} failed; the input may be corrupt or unsupported`))
      else resolve(stdout)
    })
  })
}

const INPUT_PROTOCOLS = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi']
const TOOL_LIMITS = ['-max_alloc', '67108864']
export class FilmRenderManager {
  private options: ManagerOptions
  private run: RunTool
  private jobs = new Map<string, Job>()
  private starting = false
  constructor(options: ManagerOptions) {
    this.options = options
    this.run = options.runTool || createFilmToolRunner(options.tools)
  }
  isBusy(): boolean { return this.starting || [...this.jobs.values()].some(job => !job.settled) }
  async start(value: unknown): Promise<FilmRenderResult> {
    if (this.isBusy()) return { success: false, error: '已有整片合成任务，请等待完成或取消后重试。' }
    this.starting = true
    try {
      const request = validateFilmRequest(value)
      const mediaRoot = fs.realpathSync(this.options.mediaRoot())
      const output = await this.options.chooseOutput(request)
      if (!output) return { success: false, cancelled: true }
      if (!path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.mp4') throw new Error('请选择本地 MP4 输出路径。')
      try { fs.lstatSync(output); return { success: false, error: '输出文件已存在；为保护原文件，请选择新的文件名。' } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const jobId = randomUUID()
      const status: FilmRenderStatus = { jobId, projectId: request.projectId, projectName: request.projectName, phase: 'queued', progress: 0, processedClips: 0, totalClips: request.clips.length }
      const job: Job = { mediaRoot, settled: false, status, request, output, controller: new AbortController(), finished: Promise.resolve(status) }
      this.jobs.set(jobId, job)
      job.finished = this.execute(job)
      // Bound retained completed-job metadata. Paths are revealed only through known jobs.
      if (this.jobs.size > 20) {
        const oldest = [...this.jobs.entries()].find(([id, item]) => id !== jobId && ['completed', 'cancelled', 'failed'].includes(item.status.phase))
        if (oldest) this.jobs.delete(oldest[0])
      }
      return { success: true, job: { ...status } }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : '无法启动整片合成。' } }
    finally { this.starting = false }
  }
  status(jobId: string): FilmRenderResult {
    const job = this.jobs.get(jobId)
    return job ? { success: true, job: { ...job.status } } : { success: false, error: '合成任务不存在或已过期。' }
  }
  cancel(jobId: string): FilmRenderActionResult {
    const job = this.jobs.get(jobId)
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status.phase)) return { success: false, error: '没有可取消的运行中任务。' }
    job.controller.abort()
    return { success: true }
  }
  reveal(jobId: string): FilmRenderActionResult {
    const job = this.jobs.get(jobId)
    if (!job || job.status.phase !== 'completed' || !job.status.outputPath || !fs.existsSync(job.status.outputPath)) return { success: false, error: '合成文件尚未完成或已被移走。' }
    this.options.reveal(job.status.outputPath)
    return { success: true }
  }
  whenFinished(jobId: string): Promise<FilmRenderStatus> {
    const job = this.jobs.get(jobId)
    if (!job) return Promise.reject(new Error('Unknown film job'))
    return job.finished.then(status => ({ ...status }))
  }
  async shutdown(): Promise<void> { this.cancelAll(); await Promise.all([...this.jobs.values()].map(job => job.finished)) }
  cancelAll(): void { for (const job of this.jobs.values()) if (!['completed', 'cancelled', 'failed'].includes(job.status.phase)) job.controller.abort() }
  private async execute(job: Job): Promise<FilmRenderStatus> {
    let directory: string | undefined
    const signal = job.controller.signal
    const update = (phase: FilmRenderPhase, progress: number) => { job.status.phase = phase; job.status.progress = progress }
    const probe = async (file: string) => {
      const json = await this.run('ffprobe', ['-v', 'error', ...TOOL_LIMITS, ...INPUT_PROTOCOLS, '-show_streams', '-show_format', '-of', 'json', file], signal, directory!)
      return JSON.parse(json) as FilmProbe
    }
    try {
      // Same-volume staging permits atomic hard-link publication without overwriting.
      directory = await fs.promises.mkdtemp(path.join(path.dirname(job.output), '.yitoken-film-'))
      const dimensions = outputDimensions(job.request.aspectRatio, job.request.resolution)
      const durations: number[] = []
      let inputBytes = 0, encodedBytes = 0, sourceSeconds = 0, normalizedSeconds = 0
      for (let index = 0; index < job.request.clips.length; index++) {
        if (signal.aborted) throw new Error('Film render cancelled')
        const clip = job.request.clips[index]
        job.status.currentClip = clip.name
        const input = path.join(directory, `input-${index}.mp4`)
        if (clip.sourceUrl.startsWith('local-image://')) {
          const source = resolveMediaPath(job.mediaRoot, clip.sourceUrl)
          const stat = await fs.promises.stat(source)
          if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILM_CLIP_BYTES || inputBytes + stat.size > FILM_LIMITS.totalBytes) throw new Error('素材文件为空、过大或源素材总大小超过 2 GiB。')
          await fs.promises.copyFile(source, input, fs.constants.COPYFILE_EXCL)
        } else {
          update('downloading', index / job.request.clips.length * 80)
          await (this.options.download || downloadFilmAsset)(clip.sourceUrl, input, signal, Math.min(MAX_FILM_CLIP_BYTES, FILM_LIMITS.totalBytes - inputBytes))
        }
        inputBytes += (await fs.promises.stat(input)).size
        if (inputBytes > FILM_LIMITS.totalBytes) throw new Error('源素材总大小超过 2 GiB。')
        update('probing', index / job.request.clips.length * 80)
        const inputProbe = inspectVideo(await probe(input))
        sourceSeconds += inputProbe.duration
        if (sourceSeconds > FILM_LIMITS.totalSeconds) throw new Error('整片时长超过 2 小时限制。')
        const frames = Math.ceil(inputProbe.duration * 30)
        const duration = frames / 30
        const segment = path.join(directory, `clip-${index}.mp4`)
        update('normalizing', index / job.request.clips.length * 80 + 5 / job.request.clips.length)
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...TOOL_LIMITS, '-threads', '2', ...INPUT_PROTOCOLS, '-i', input]
        if (!inputProbe.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
        args.push('-map', '0:v:0', '-map', inputProbe.hasAudio ? '0:a:0' : '1:a:0', '-vf', `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=0.04,format=yuv420p`, '-af', `aresample=48000,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS`, '-frames:v', String(frames), '-t', String(duration), '-fs', String(MAX_FILM_CLIP_BYTES), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-threads', '2', segment)
        await this.run('ffmpeg', args, signal, directory)
        const segmentSize = (await fs.promises.stat(segment)).size
        encodedBytes += segmentSize
        if (segmentSize === 0 || segmentSize > MAX_FILM_CLIP_BYTES || encodedBytes > FILM_LIMITS.totalBytes) throw new Error('Encoded video exceeds disk budget')
        validateFilmOutput(await probe(segment), dimensions, duration)
        await fs.promises.unlink(input)
        normalizedSeconds += duration
        durations.push(duration)
        job.status.processedClips = index + 1
        job.status.progress = (index + 1) / job.request.clips.length * 80
      }
      if (signal.aborted) throw new Error('Film render cancelled')
      update('concatenating', 85)
      const list = path.join(directory, 'clips.txt')
      await fs.promises.writeFile(list, job.request.clips.flatMap((_clip, index) => [`file 'clip-${index}.mp4'`, `duration ${durations[index]}`]).join('\n'), { flag: 'wx' })
      const rendered = path.join(directory, 'output.mp4')
      await this.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...TOOL_LIMITS, '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', list, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-fs', String(FILM_LIMITS.totalBytes), rendered], signal, directory)
      update('validating', 92)
      const outputSize = (await fs.promises.stat(rendered)).size
      if (outputSize === 0 || outputSize > FILM_LIMITS.totalBytes) throw new Error('Encoded film exceeds disk budget')
      validateFilmOutput(await probe(rendered), dimensions, normalizedSeconds)
      // Metadata inspection is not enough: decode every video/audio packet before publishing.
      await this.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', ...TOOL_LIMITS, '-threads', '2', ...INPUT_PROTOCOLS, '-i', rendered, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], signal, directory)
      if (signal.aborted) throw new Error('Film render cancelled')
      // link() is atomic, same-volume and EEXIST-safe. Never publish a partial copied file.
      fs.linkSync(rendered, job.output)
      job.status.outputPath = job.output
      delete job.status.currentClip
      update('completed', 100)
    } catch (error) {
      update(signal.aborted ? 'cancelled' : 'failed', job.status.progress)
      job.status.error = signal.aborted ? '整片合成已取消，未保存输出文件。' : error instanceof Error && ['EEXIST', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code || '') ? '无法安全保存：文件已存在或目标磁盘不支持原子硬链接；请换新文件名或本地磁盘。' : '整片合成失败：素材缺失、损坏、不受支持或超过资源限制；未保存输出文件。'
    } finally {
      if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {})
      job.settled = true
    }
    return { ...job.status }
  }
}
