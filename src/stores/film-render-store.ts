// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// YITOKEN changes: immutable project-owned render requests and main-process job state.
import { create } from 'zustand';
import type { Project } from './project-store';
import type { TimelineClip } from './simple-timeline-store';
import type { FilmRendererBridge, FilmRenderRequest, FilmRenderStatus } from '@/types/film-render';

type TimelineSource = { boundProjectId: string | null; loadError: string | null; clips: TimelineClip[] };
type CachedMedia = { id: string; type: string; url?: string };
export function createFilmRenderSnapshot(
  project: Project | null,
  timeline: TimelineSource,
  profile: Pick<FilmRenderRequest, 'aspectRatio' | 'resolution'>,
  media: CachedMedia[] = [],
): FilmRenderRequest {
  if (!project || timeline.boundProjectId !== project.id) throw new Error('当前项目时间线尚未加载，不能合成');
  if (timeline.loadError) throw new Error(timeline.loadError);
  if (!timeline.clips.length) throw new Error('当前项目时间线没有视频，请先在导演或素材页拖入并排序');
  const clips = timeline.clips.map((clip, index) => {
    const cached = media.find(item => item.id === clip.mediaId && item.type === 'video' && item.url?.startsWith('local-image://'));
    const sourceUrl = cached?.url || clip.url;
    if (!sourceUrl || (!sourceUrl.startsWith('local-image://') && !sourceUrl.startsWith('https://'))) throw new Error(`片段 ${index + 1}「${clip.name}」尚未保存为可用本地视频，请等待缓存完成或重新导入`);
    return { id: clip.id, mediaId: clip.mediaId, name: clip.name || `片段 ${index + 1}`, sourceUrl };
  });
  return { projectId: project.id, projectName: project.name, aspectRatio: profile.aspectRatio, resolution: profile.resolution, clips };
}

export const isFilmRenderActive = (job: FilmRenderStatus | null): boolean => !!job && !['completed', 'cancelled', 'failed'].includes(job.phase);
interface FilmRenderStore {
  job: FilmRenderStatus | null;
  snapshot: FilmRenderRequest | null;
  starting: boolean;
  cancelling: boolean;
  error: string | null;
  start: (request: FilmRenderRequest, bridge: FilmRendererBridge) => Promise<void>;
  refresh: (bridge: FilmRendererBridge) => Promise<void>;
  cancel: (bridge: FilmRendererBridge) => Promise<void>;
  reveal: (bridge: FilmRendererBridge) => Promise<void>;
}

// Deliberately session-only and global: a project switch never retargets or clears
// a running job. Its immutable snapshot is displayed independently of the editor.
export const useFilmRenderStore = create<FilmRenderStore>((set, get) => ({
  job: null, snapshot: null, starting: false, cancelling: false, error: null,
  async start(request, bridge) {
    if (get().starting || isFilmRenderActive(get().job)) return;
    const snapshot = {
      projectId: request.projectId, projectName: request.projectName,
      aspectRatio: request.aspectRatio, resolution: request.resolution,
      clips: request.clips.map(clip => ({ id: clip.id, mediaId: clip.mediaId, name: clip.name, sourceUrl: clip.sourceUrl })),
    };
    set({ snapshot, starting: true, cancelling: false, error: null, job: null });
    try {
      const result = await bridge.start(snapshot);
      if (result.cancelled) { set({ snapshot: null }); return; }
      if (!result.success || !result.job) throw new Error(result.error || '无法启动整片合成');
      if (result.job.phase === 'completed' && !result.job.outputPath) throw new Error('完成状态缺少已验证保存位置，不能确认成功');
      set({ job: result.job });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '启动失败，请核对主进程任务状态后再重试' });
    } finally { set({ starting: false }); }
  },
  async refresh(bridge) {
    const jobId = get().job?.jobId;
    if (!jobId) return;
    try {
      const result = await bridge.status(jobId);
      if (!result.success || !result.job) throw new Error(result.error || '无法读取合成进度；不会据此报告成功');
      if (get().job?.jobId !== jobId || result.job.jobId !== jobId) return;
      if (result.job.phase === 'completed' && !result.job.outputPath) throw new Error('完成状态缺少已验证保存位置，不能确认成功');
      set({ job: result.job, error: null, cancelling: isFilmRenderActive(result.job) ? get().cancelling : false });
    } catch (error) { set({ error: error instanceof Error ? error.message : '合成状态读取失败' }); }
  },
  async cancel(bridge) {
    const job = get().job;
    if (!job || !isFilmRenderActive(job) || get().cancelling) return;
    set({ cancelling: true, error: null });
    try {
      const result = await bridge.cancel(job.jobId);
      if (!result.success) throw new Error(result.error || '取消失败，任务可能仍在运行');
      // Do not fake a cancelled result; only main-process status confirms it.
    } catch (error) { set({ cancelling: false, error: error instanceof Error ? error.message : '取消失败' }); }
  },
  async reveal(bridge) {
    const job = get().job;
    if (!job || job.phase !== 'completed' || !job.outputPath) return;
    try {
      const result = await bridge.reveal(job.jobId);
      if (!result.success) throw new Error(result.error || '无法打开保存位置');
    } catch (error) { set({ error: error instanceof Error ? error.message : '无法打开保存位置' }); }
  },
}));
