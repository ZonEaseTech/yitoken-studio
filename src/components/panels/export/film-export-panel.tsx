// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// YITOKEN changes: local whole-film export, independent from material downloads.
import { useState } from 'react';
import { Film, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useSimpleTimelineStore } from '@/stores/simple-timeline-store';
import { useMediaStore } from '@/stores/media-store';
import { useMediaPanelStore } from '@/stores/media-panel-store';
import { createFilmRenderSnapshot, isFilmRenderActive, useFilmRenderStore } from '@/stores/film-render-store';
import { FILM_PHASE_LABELS, filmRendererBridge } from '@/components/FilmRenderMonitor';
import type { Project } from '@/stores/project-store';
import type { FilmRenderRequest } from '@/types/film-render';

export function FilmExportPanel({ project, aspectRatio }: { project: Project | null; aspectRatio: FilmRenderRequest['aspectRatio'] }) {
  const timeline = useSimpleTimelineStore();
  const media = useMediaStore(state => state.mediaFiles);
  const { setActiveTab } = useMediaPanelStore();
  const { job, snapshot, starting, cancelling, error, start, cancel, reveal } = useFilmRenderStore();
  const [resolution, setResolution] = useState<FilmRenderRequest['resolution']>('720p');
  const [validationError, setValidationError] = useState<string | null>(null);
  const active = isFilmRenderActive(job);
  const busy = active || starting;
  const owned = !!project && timeline.boundProjectId === project.id && !timeline.loadError;
  const currentClips = owned ? timeline.clips : [];
  const visibleClips = busy && snapshot ? snapshot.clips : currentClips;
  const displayedName = busy ? job?.projectName || snapshot?.projectName : project?.name;
  const bridge = filmRendererBridge();

  const handleStart = async () => {
    if (!bridge || busy) return;
    setValidationError(null);
    try {
      const request = createFilmRenderSnapshot(project, timeline, { aspectRatio, resolution }, media);
      await start(request, bridge);
    } catch (failure) { setValidationError(failure instanceof Error ? failure.message : '无法读取当前项目时间线'); }
  };
  return (
    <section aria-labelledby="film-export-heading" className="rounded-xl border border-primary/30 bg-card p-6 space-y-4">
      <h3 id="film-export-heading" className="flex items-center gap-2 text-xl font-bold"><Film className="h-5 w-5 text-primary" />合成整片 MP4</h3>
      <p className="text-sm text-muted-foreground">按当前项目时间线顺序合并完整视频片段；保留原音频，无音轨补静音。统一 30 fps、等比例黑边，不拉伸画面。此操作在本机完成，不提交 AI 生成请求，不另收生成费。</p>
      <p className="text-xs text-muted-foreground">不包含转场、字幕、背景音乐或多轨剪辑。每段最长 10 分钟、最多 200 段，总时长最多 2 小时；每个源文件最多 512 MiB，源文件合计最多 2 GiB。实际时长由本机检测，不按时间线估算值裁片。</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium break-words">{busy ? '冻结合成项目' : '当前项目'}：{displayedName || '未选择项目'}</span>
        <span className="text-muted-foreground">{busy && snapshot ? snapshot.aspectRatio : aspectRatio} · 30 fps</span>
        <label className="flex items-center gap-2">输出尺寸
          <select aria-label="整片输出尺寸" className="rounded border border-border bg-background px-2 py-1" disabled={busy} value={resolution} onChange={e => setResolution(e.target.value as FilmRenderRequest['resolution'])}>
            <option value="720p">720p</option><option value="1080p">1080p</option>
          </select>
        </label>
        {busy && snapshot && <span className="text-muted-foreground">本次任务：{snapshot.resolution}</span>}
      </div>
      {visibleClips.length ? (
        <ol aria-label="整片片段顺序" className="max-h-40 overflow-y-auto rounded border border-border divide-y divide-border">
          {visibleClips.map((clip, index) => <li key={`${clip.id}-${index}`} className="px-3 py-2 text-sm break-words">{index + 1}. {clip.name}</li>)}
        </ol>
      ) : <p className="text-sm text-muted-foreground">当前项目时间线没有可合成片段。请在导演或素材页将视频拖入时间线并排序；不会自动把所有分镜当作整片。</p>}
      {!busy && timeline.loadError && <p role="alert" className="text-sm text-destructive">{timeline.loadError}</p>}
      {!bridge && <p className="text-sm text-muted-foreground">整片合成仅桌面版可用；浏览器预览不能启动本机 FFmpeg。</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setActiveTab('media')}>到素材页调整时间线</Button>
        <Button disabled={!bridge || !owned || !currentClips.length || busy} onClick={() => void handleStart()}>
          {starting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{starting ? '等待选择保存位置' : '合成整片 MP4'}
        </Button>
        {active && <Button variant="outline" disabled={cancelling || !bridge} onClick={() => { if (bridge) void cancel(bridge); }}>{cancelling ? '正在停止，请稍候' : '取消合成'}</Button>}
      </div>
      {job && <div aria-live="polite" className="rounded border border-border p-4 space-y-2">
        <p className="font-medium text-sm">任务项目：{job.projectName} · {FILM_PHASE_LABELS[job.phase]}</p>
        <p className="text-xs text-muted-foreground">已处理片段 {job.processedClips}/{job.totalClips} · {Math.round(job.progress)}%{job.currentClip ? ` · 当前片段：${job.currentClip}` : ''}</p>
        <Progress value={Math.max(0, Math.min(100, job.progress))} />
        {job.phase === 'completed' && job.outputPath && <>
          <p className="text-sm text-green-600">整片已验证并保存。保存位置：<span className="break-all">{job.outputPath}</span></p>
          <Button size="sm" variant="outline" onClick={() => { if (bridge) void reveal(bridge); }}><FolderOpen className="mr-2 h-4 w-4" />打开保存位置</Button>
        </>}
        {job.phase === 'cancelled' && <p className="text-sm text-muted-foreground">任务已停止，源视频和原有目标文件保留。本次未生成可用整片。</p>}
        {job.error && <p role="alert" className="text-sm text-destructive break-words">{job.error}</p>}
      </div>}
      {(validationError || error) && <p role="alert" className="text-sm text-destructive break-words">{validationError || error}</p>}
    </section>
  );
}
