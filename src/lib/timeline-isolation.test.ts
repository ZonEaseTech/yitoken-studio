import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  projectId: 'A', files: new Map<string, string>(), failRead: '', reads: [] as string[],
}));
vi.mock('@/lib/indexed-db-storage', () => ({ fileStorage: {
  getItem: async (key: string) => { fixture.reads.push(key); if (fixture.failRead === key) throw new Error('read failed'); return fixture.files.get(key) ?? null; },
  setItem: async (key: string, value: string) => { fixture.files.set(key, value); }, removeItem: async (key: string) => { fixture.files.delete(key); },
} }));
vi.mock('@/stores/project-store', () => ({ useProjectStore: {
  getState: () => ({ activeProjectId: fixture.projectId, setActiveProject: (id: string) => { fixture.projectId = id; } }),
  persist: { hasHydrated: () => true },
} }));
vi.mock('@/stores/app-settings-store', () => ({ useAppSettingsStore: { getState: () => ({ resourceSharing: {} }) } }));
const emptyStore = vi.hoisted(() => () => ({ persist: { rehydrate: async () => {} }, getState: () => ({ setActiveProjectId: () => {}, ensureProject: () => {} }) }));
vi.mock('@/stores/script-store', () => ({ useScriptStore: emptyStore() }));
vi.mock('@/stores/director-store', () => ({ useDirectorStore: emptyStore() }));
vi.mock('@/stores/media-store', () => ({ useMediaStore: emptyStore() }));
vi.mock('@/stores/character-library-store', () => ({ useCharacterLibraryStore: emptyStore() }));
vi.mock('@/stores/scene-store', () => ({ useSceneStore: emptyStore() }));
vi.mock('@/stores/sclass-store', () => ({ useSClassStore: emptyStore() }));

import { useSimpleTimelineStore } from '@/stores/simple-timeline-store';
import { usePreviewStore } from '@/stores/preview-store';
import { flushTimelineWrites } from './project-storage';
import { switchProject } from './project-switcher';

afterEach(() => { vi.unstubAllGlobals(); });

const aClip = { id: 'a', mediaId: 'ma', name: 'A video', url: 'local-image://videos/a.mp4', duration: 7, startTime: 0 };
const payload = (clips = [aClip]) => JSON.stringify({ state: { clips, totalDuration: 7 }, version: 0 });
beforeEach(async () => {
  fixture.projectId = 'A'; fixture.failRead = ''; fixture.files.clear(); fixture.reads.length = 0;
  fixture.files.set('_p/A/timeline', payload());
  await useSimpleTimelineStore.persist.rehydrate();
});

describe('project-owned timeline and playback', () => {
  it('A -> empty B -> A restores only A clips and clears old playback', async () => {
    const pause = vi.fn();
    usePreviewStore.setState({ videoRef: { pause, currentTime: 3 } as any });
    usePreviewStore.getState().setPlaylist([{ type: 'video', url: aClip.url }]);
    await switchProject('B');
    expect(useSimpleTimelineStore.getState().clips).toEqual([]);
    expect((useSimpleTimelineStore.getState() as any).boundProjectId).toBe('B');
    expect(usePreviewStore.getState()).toMatchObject({ playlist: [], previewItem: null, isPlaying: false });
    expect(pause).toHaveBeenCalled();
    await switchProject('A');
    expect(useSimpleTimelineStore.getState().clips.map(c => c.id)).toEqual(['a']);
    expect((useSimpleTimelineStore.getState() as any).boundProjectId).toBe('A');
  });

  it('does not assign legacy global clips to an empty project or persist old A into B', async () => {
    fixture.files.set('moyin-timeline-store', payload());
    await switchProject('B');
    expect(useSimpleTimelineStore.getState().clips).toEqual([]);
    expect(fixture.reads).not.toContain('moyin-timeline-store');
    useSimpleTimelineStore.getState().addClip({ ...aClip, name: 'B own', mediaId: 'mb' });
    await useSimpleTimelineStore.persist.rehydrate();
    const saved = JSON.parse(fixture.files.get('_p/B/timeline')!);
    expect(saved.state.boundProjectId).toBe('B');
    expect(saved.state.clips).toHaveLength(1);
    expect(JSON.parse(fixture.files.get('_p/A/timeline')!).state.clips).toEqual([aClip]);
  });

  it('serializes rapid switching and clears a failed read rather than retaining old clips', async () => {
    fixture.failRead = '_p/B/timeline';
    const b = switchProject('B');
    const c = switchProject('C');
    await Promise.all([b, c]);
    expect(fixture.projectId).toBe('C');
    expect((useSimpleTimelineStore.getState() as any).boundProjectId).toBe('C');
    expect(useSimpleTimelineStore.getState().clips).toEqual([]);
    fixture.failRead = '_p/A/timeline';
    await switchProject('A');
    expect(useSimpleTimelineStore.getState().clips).toEqual([]);
    expect((useSimpleTimelineStore.getState() as any).loadError).toContain('读取');
    expect(JSON.parse(fixture.files.get('_p/A/timeline')!).state.clips).toEqual([aClip]);
  });
});

it('corrupt persisted clips clear the visible project timeline without overwriting the damaged original', async () => {
  const corrupt = JSON.stringify({ state: { clips: [null], totalDuration: 5 } });
  fixture.files.set('_p/B/timeline', corrupt);
  await switchProject('B');
  expect(useSimpleTimelineStore.getState().clips).toEqual([]);
  expect((useSimpleTimelineStore.getState() as any).loadError).toContain('读取');
  expect(fixture.files.get('_p/B/timeline')).toBe(corrupt);
});

it('refuses to switch away after the native filesystem reports a failed timeline save', async () => {
  vi.stubGlobal('window', { fileStorage: { setItem: vi.fn(async () => false) } });
  useSimpleTimelineStore.getState().addClip({ ...aClip, mediaId: 'unsaved', name: 'unsaved clip' });
  await expect(switchProject('B')).rejects.toThrow('未能保存');
  expect(fixture.projectId).toBe('A');
  expect(useSimpleTimelineStore.getState().clips).toHaveLength(2);
  expect(fixture.files.has('_p/B/timeline')).toBe(false);
  // Clicking another project again retries the same bound A snapshot, without
  // requiring a fake playback/edit operation or losing the in-memory changes.
  vi.stubGlobal('window', { fileStorage: {
    setItem: vi.fn(async (key: string, value: string) => { fixture.files.set(key, value); return true; }),
    getItem: async (key: string) => fixture.files.get(key) ?? null,
  } });
  await switchProject('B');
  expect(fixture.projectId).toBe('B');
  expect(useSimpleTimelineStore.getState().clips).toEqual([]);
  expect(JSON.parse(fixture.files.get('_p/A/timeline')!).state.clips).toHaveLength(2);
  await switchProject('A');
  expect(useSimpleTimelineStore.getState().clips).toHaveLength(2);
});

it('reopening the same project retries a failed read without requiring a different project', async () => {
  await switchProject('B');
  fixture.failRead = '_p/A/timeline';
  await switchProject('A');
  expect(useSimpleTimelineStore.getState().clips).toEqual([]);
  fixture.failRead = '';
  await switchProject('A');
  expect(useSimpleTimelineStore.getState().clips.map(clip => clip.id)).toEqual(['a']);
  expect((useSimpleTimelineStore.getState() as any).loadError).toBeNull();
});


it('a copied project timeline is bound to the copy and remains renderable without changing source', async () => {
  const { copyProjectTimeline } = await import('./project-copy');
  const original = JSON.stringify({ state: { boundProjectId:'A',clips:[aClip],totalDuration:7 },version:0 });
  fixture.files.set('_p/A/timeline',original);
  fixture.files.set('_p/B/timeline',copyProjectTimeline(original,'A','B'));
  await switchProject('B');
  expect(useSimpleTimelineStore.getState()).toMatchObject({boundProjectId:'B',loadError:null});
  expect(useSimpleTimelineStore.getState().clips.map(clip=>clip.id)).toEqual(['a']);
  expect(fixture.files.get('_p/A/timeline')).toBe(original);
  expect(() => copyProjectTimeline(original,'different-project','B')).toThrow(/ownership/i);
});

it('startup reloads the active timeline after legacy migration before the first edit can overwrite it', async () => {
  fixture.files.delete('_p/A/timeline');
  await useSimpleTimelineStore.persist.rehydrate();
  expect(useSimpleTimelineStore.getState().clips).toEqual([]);
  fixture.files.set('moyin-project-store', JSON.stringify({ state: { projects: [{ id: 'A' }], activeProjectId: 'A' } }));
  fixture.files.set('moyin-timeline-store', payload());
  vi.stubGlobal('window', { fileStorage: {
    exists: async (key: string) => fixture.files.has(key),
    getItem: async (key: string) => fixture.files.get(key) ?? null,
    setItem: async (key: string, value: string) => { fixture.files.set(key, value); return true; },
  } });
  const effects: Array<() => unknown> = [];
  vi.doMock('react', async () => ({
    ...await vi.importActual<typeof import('react')>('react'),
    useEffect: (effect: () => unknown) => { effects.push(effect); },
    useState: (value: unknown) => [value, vi.fn()],
  }));
  vi.doMock('@/components/Layout', () => ({ Layout: () => null }));
  vi.doMock('@/components/FilmRenderMonitor', () => ({ FilmRenderMonitor: () => null }));
  vi.doMock('@/components/UpdateDialog', () => ({ UpdateDialog: () => null }));
  vi.doMock('@/stores/theme-store', () => ({ useThemeStore: () => ({ theme: 'dark' }) }));
  vi.doMock('@/stores/api-config-store', () => ({ useAPIConfigStore: { persist: { rehydrate: async () => {} } } }));
  vi.doMock('@/stores/app-settings-store', () => ({ useAppSettingsStore: Object.assign(
    () => ({ updateSettings: { autoCheckEnabled: false }, setUpdateSettings: vi.fn() }),
    { persist: { rehydrate: async () => {} } },
  ) }));
  try {
    const { default: App } = await import('@/App');
    App();
    effects[0]();
    await vi.waitFor(() => expect(useSimpleTimelineStore.getState().clips.map(clip => clip.id)).toEqual(['a']));
    useSimpleTimelineStore.getState().addClip({ ...aClip, name: 'new clip', mediaId: 'new' });
    await flushTimelineWrites();
    expect(JSON.parse(fixture.files.get('_p/A/timeline')!).state.clips.map((clip: any) => clip.name)).toEqual(['A video', 'new clip']);
  } finally {
    for (const name of ['react', '@/components/Layout', '@/components/FilmRenderMonitor', '@/components/UpdateDialog', '@/stores/theme-store', '@/stores/api-config-store', '@/stores/app-settings-store']) vi.doUnmock(name);
  }
});

it.each(['director', 'media'].flatMap(format => ['wrong-project', 'read-error', 'invalid-duration', 'valid'].map(state => [format, state] as const)))('timeline drop from %s reports only an actual accepted clip for %s', async (format, state) => {
  const { toast } = await import('sonner');
  const success = vi.spyOn(toast, 'success').mockReturnValue('success');
  const error = vi.spyOn(toast, 'error').mockReturnValue('error');
  vi.doMock('react', async () => ({
    ...await vi.importActual<typeof import('react')>('react'),
    useState: (value: unknown) => [value, vi.fn()],
    useCallback: (callback: unknown) => callback,
  }));
  vi.doMock('@/stores/project-store', () => ({ useProjectStore: Object.assign(
    (selector?: (value: any) => unknown) => selector ? selector({ activeProjectId: fixture.projectId }) : { activeProjectId: fixture.projectId },
    { getState: () => ({ activeProjectId: fixture.projectId }) },
  ) }));
  vi.doMock('@/stores/simple-timeline-store', () => ({ useSimpleTimelineStore: Object.assign(() => useSimpleTimelineStore.getState(), { getState: useSimpleTimelineStore.getState }) }));
  vi.doMock('@/stores/preview-store', () => ({ usePreviewStore: () => usePreviewStore.getState() }));
  try {
    if (state === 'wrong-project') fixture.projectId = 'B';
    if (state === 'read-error') useSimpleTimelineStore.setState({ loadError: '时间线读取失败' });
    const { SimpleTimeline } = await import('@/components/SimpleTimeline');
    let onDrop: ((event: any) => void) | undefined;
    const visit = (node: any) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node?.props) return;
      if (!onDrop && node.props.onDrop) onDrop = node.props.onDrop;
      visit(node.props.children);
    };
    visit(SimpleTimeline());
    expect(onDrop).toBeTypeOf('function');
    const duration = state === 'invalid-duration' ? -2 : 7;
    const item = format === 'director'
      ? { type: 'video', id: 'drop', name: 'Dropped video', url: aClip.url, duration }
      : { type: 'media', mediaType: 'video', mediaId: 'drop', name: 'Dropped video', url: aClip.url, duration };
    const sourceType = format === 'director' ? 'application/x-media-item' : 'application/json';
    const originalIds = useSimpleTimelineStore.getState().clips.map(clip => clip.id);
    onDrop!({ preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { getData: (type: string) => type === sourceType ? JSON.stringify(item) : '' } });
    if (state === 'valid') {
      expect(useSimpleTimelineStore.getState().clips).toHaveLength(originalIds.length + 1);
      expect(success).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
    } else {
      expect(useSimpleTimelineStore.getState().clips.map(clip => clip.id)).toEqual(originalIds);
      expect(success).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
    }
  } finally {
    for (const name of ['react', '@/stores/project-store', '@/stores/simple-timeline-store', '@/stores/preview-store']) vi.doUnmock(name);
  }
});

it('project header identifies a local workspace instead of simulating a saved result', async () => {
  vi.doMock('react', async () => ({
    ...await vi.importActual<typeof import('react')>('react'),
    useState: (value: unknown) => [value, vi.fn()],
    useRef: (value: unknown) => ({ current: value }),
    useEffect: () => {},
  }));
  vi.doMock('@/stores/project-store', () => ({ useProjectStore: () => ({ activeProject: { id: 'A', name: 'Project A' } }) }));
  vi.doMock('@/stores/script-store', () => ({ useScriptStore: () => ({ projects: {} }) }));
  vi.doMock('@/stores/media-panel-store', () => ({ useMediaPanelStore: () => ({}), stages: [] }));
  try {
    const { ProjectHeader } = await import('@/components/ProjectHeader');
    const text = (node: any): string => {
      if (Array.isArray(node)) return node.map(text).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (!node?.props) return '';
      if (typeof node.type === 'function') return text(node.type(node.props));
      return text(node.props.children);
    };
    const label = text(ProjectHeader());
    expect(label).toContain('本地工作区');
    expect(label).not.toMatch(/saved|saving|unsaved|已保存|自动保存/i);
  } finally {
    for (const name of ['react', '@/stores/project-store', '@/stores/script-store', '@/stores/media-panel-store']) vi.doUnmock(name);
  }
});
