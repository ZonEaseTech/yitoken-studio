// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// YITOKEN changes: global main-process rendering progress survives project navigation.
import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useFilmRenderStore, isFilmRenderActive } from '@/stores/film-render-store';
import type { FilmRendererBridge, FilmRenderPhase } from '@/types/film-render';
import { Button } from '@/components/ui/button';
import { useMediaPanelStore } from '@/stores/media-panel-store';

export const FILM_PHASE_LABELS: Record<FilmRenderPhase, string> = {
  queued: '准备合成', downloading: '缓存视频', probing: '检测实际媒体', normalizing: '统一画面与音频',
  concatenating: '按顺序拼接', validating: '验证 MP4 与保存', completed: '整片已验证并保存', cancelled: '已取消', failed: '合成失败',
};
export function filmRendererBridge(): FilmRendererBridge | undefined {
  return typeof window !== 'undefined' ? (window as Window & { filmRenderer?: FilmRendererBridge }).filmRenderer : undefined;
}

export function FilmRenderMonitor() {
  const { job, snapshot, starting, cancelling, error, refresh, cancel, reveal } = useFilmRenderStore();
  const active = isFilmRenderActive(job);
  const [dismissedJob, setDismissedJob] = useState<string | null>(null);
  const { inProject, activeTab, setActiveTab, setInProject } = useMediaPanelStore();
  useEffect(() => {
    const bridge = filmRendererBridge();
    if (!active || !bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh(bridge);
      if (!stopped && isFilmRenderActive(useFilmRenderStore.getState().job)) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, job?.jobId, refresh]);

  // The export panel already shows the full task. Other screens get a small,
  // bounded card; it does not intercept the surrounding page's pointer events.
  if ((!job && !starting) || (!active && !starting && job?.jobId === dismissedJob) || (inProject && activeTab === 'export')) return null;
  return (
    <aside aria-label="后台整片合成" className="fixed bottom-3 right-3 z-40 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-panel p-3 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-semibold">合成项目：{job?.projectName || snapshot?.projectName}</p>
        {!active && !starting && job && <button aria-label="关闭合成结果提示" className="shrink-0 p-1 text-muted-foreground" onClick={() => setDismissedJob(job.jobId)}><X className="h-3 w-3" /></button>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
        {starting ? '等待保存位置选择' : job ? `${FILM_PHASE_LABELS[job.phase]} · ${Math.round(job.progress)}%` : ''}
        {cancelling ? ' · 正在停止任务' : ''}
      </p>
      {(error || job?.error) && <p role="alert" className="mt-1 text-xs text-destructive break-words">{error || job?.error}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => { setInProject(true); setActiveTab('export'); }}>查看合成任务</Button>
        {job?.phase === 'completed' && job.outputPath && <Button size="sm" variant="ghost" onClick={() => { const bridge = filmRendererBridge(); if (bridge) void reveal(bridge); }}>保存位置</Button>}
        {active && <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => { const bridge = filmRendererBridge(); if (bridge) void cancel(bridge); }}>
          {cancelling && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}取消
        </Button>}
      </div>
    </aside>
  );
}
