import { beforeEach, expect, it, vi } from 'vitest';
import type { FilmRenderRequest } from '@/types/film-render';
import { createFilmRenderSnapshot, useFilmRenderStore } from './film-render-store';

const clips = [
  { id: 'second', mediaId: 'm2', name: 'second', url: 'https://assets.example/two.mp4', duration: 5, startTime: 0 },
  { id: 'first', mediaId: 'm1', name: 'first', url: 'local-image://videos/one.mp4', duration: 999, startTime: 5 },
];
const project = { id: 'A', name: 'Project A', createdAt: 0, updatedAt: 0 };
const profile = { aspectRatio: '16:9' as const, resolution: '720p' as const };
const timeline = { boundProjectId: 'A', loadError: null, clips };
const job = { jobId: 'job1', projectId: 'A', projectName: 'Project A', phase: 'queued' as const, progress: 0, processedClips: 0, totalClips: 2 };
beforeEach(() => { useFilmRenderStore.setState({ job: null, snapshot: null, starting: false, cancelling: false, error: null }); });

it('snapshots only the project-bound ordered clips without estimated durations, commands or paths', () => {
  const snapshot = createFilmRenderSnapshot(project, timeline, profile, [{ id: 'm2', type: 'video', url: 'local-image://videos/two.mp4' }]);
  expect(snapshot).toEqual({ projectId: 'A', projectName: 'Project A', ...profile, clips: [
    { id: 'second', mediaId: 'm2', name: 'second', sourceUrl: 'local-image://videos/two.mp4' },
    { id: 'first', mediaId: 'm1', name: 'first', sourceUrl: 'local-image://videos/one.mp4' },
  ] });
  expect(() => createFilmRenderSnapshot({ ...project, id: 'B' }, timeline, profile)).toThrow('当前项目');
  expect(() => createFilmRenderSnapshot(project, { ...timeline, clips: [] }, profile)).toThrow('没有视频');
  expect(() => createFilmRenderSnapshot(project, { ...timeline, loadError: '读取失败' }, profile)).toThrow('读取失败');
});

it('keeps frozen project and order while start dialog is pending and cancellation uses IPC', async () => {
  let resolveStart!: (value: any) => void;
  const bridge = {
    start: vi.fn((_request: FilmRenderRequest) => new Promise<any>(resolve => { resolveStart = resolve; })),
    status: vi.fn(async () => ({ success: true, job })),
    cancel: vi.fn(async () => ({ success: true })), reveal: vi.fn(async () => ({ success: true })),
  };
  const source = createFilmRenderSnapshot(project, timeline, profile);
  const starting = useFilmRenderStore.getState().start(source, bridge);
  source.projectName = 'changed B'; source.clips.reverse();
  expect(useFilmRenderStore.getState().snapshot?.projectName).toBe('Project A');
  expect(bridge.start.mock.calls[0][0].clips[0].id).toBe('second');
  resolveStart({ success: true, job });
  await starting;
  await useFilmRenderStore.getState().cancel(bridge);
  expect(bridge.cancel).toHaveBeenCalledWith('job1');
  expect(useFilmRenderStore.getState().job?.phase).not.toBe('cancelled'); // Main process must confirm.
});

it('does not report a successful save when status fails or cancellation cannot stop the process', async () => {
  useFilmRenderStore.setState({ job, snapshot: createFilmRenderSnapshot(project, timeline, profile) });
  const bridge = { start: vi.fn(), status: vi.fn(async () => ({ success: false, error: 'status unavailable' })), cancel: vi.fn(async () => ({ success: false, error: 'cancel failed' })), reveal: vi.fn() };
  await useFilmRenderStore.getState().refresh(bridge);
  expect(useFilmRenderStore.getState().error).toBe('status unavailable');
  expect(useFilmRenderStore.getState().job?.phase).toBe('queued');
  await useFilmRenderStore.getState().cancel(bridge);
  expect(useFilmRenderStore.getState().error).toBe('cancel failed');
  expect(useFilmRenderStore.getState().cancelling).toBe(false);
});

it('refuses a completed result without a verified saved output path', async () => {
  useFilmRenderStore.setState({ job, snapshot: createFilmRenderSnapshot(project, timeline, profile) });
  const bridge = { start: vi.fn(), status: vi.fn(async () => ({ success: true, job: { ...job, phase: 'completed' as const } })), cancel: vi.fn(), reveal: vi.fn() };
  await useFilmRenderStore.getState().refresh(bridge);
  expect(useFilmRenderStore.getState().error).toContain('保存位置');
  expect(useFilmRenderStore.getState().job?.phase).not.toBe('completed');
});
