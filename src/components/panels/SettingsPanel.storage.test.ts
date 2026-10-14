import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: (value: unknown) => [typeof value === 'function' ? value() : value, vi.fn()],
  useEffect: () => {},
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/stores/api-config-store', () => ({
  isVisibleImageHostProvider: () => false,
  useAPIConfigStore: () => ({ providers: [], imageHostProviders: [], advancedOptions: {}, concurrency: 1, isImageHostConfigured: () => false }),
}));
vi.mock('@/stores/app-settings-store', () => ({ useAppSettingsStore: () => ({
  resourceSharing: {}, storagePaths: {}, cacheSettings: {}, updateSettings: {},
  setStoragePaths: vi.fn(), setCacheSettings: vi.fn(), setUpdateSettings: vi.fn(),
}) }));
vi.mock('@/stores/project-store', () => ({ useProjectStore: () => ({ activeProjectId: 'A' }) }));
vi.mock('@/stores/character-library-store', () => ({ useCharacterLibraryStore: () => ({}) }));
vi.mock('@/stores/scene-store', () => ({ useSceneStore: () => ({}) }));
vi.mock('@/stores/media-store', () => ({ useMediaStore: () => ({}) }));
vi.mock('@/components/api-manager', () => ({ AddProviderDialog: () => null, EditProviderDialog: () => null, FeatureBindingPanel: () => null }));
vi.mock('@/components/image-host-manager/AddImageHostDialog', () => ({ AddImageHostDialog: () => null }));
vi.mock('@/components/image-host-manager/EditImageHostDialog', () => ({ EditImageHostDialog: () => null }));
vi.mock('@/lib/image-host', () => ({ uploadToImageHost: vi.fn() }));
vi.mock('@/components/UpdateDialog', () => ({ UpdateDialog: () => null }));

import { SettingsPanel } from './SettingsPanel';
import { useFilmRenderStore } from '@/stores/film-render-store';
import { toast } from 'sonner';

const runningJob = { jobId: 'job', projectId: 'A', projectName: 'A', phase: 'normalizing' as const, progress: 40, processedClips: 0, totalClips: 1 };
const mutations = ['moveData', 'importData', 'linkData', 'clearCache'] as const;
const handlers = ['handleSelectStoragePath', 'handleImportData', 'handleLinkData', 'handleClearCache'] as const;
let storage: Record<string, ReturnType<typeof vi.fn>>;

function storageHandlers(): Map<string, () => Promise<void>> {
  const callbacks = new Map<string, () => Promise<void>>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const props = (node as ReactElement<Record<string, any>>).props;
    if (typeof props.onClick === 'function') callbacks.set(props.onClick.name, props.onClick);
    visit(props.children);
  };
  visit(SettingsPanel());
  return callbacks;
}

beforeEach(() => {
  vi.clearAllMocks();
  useFilmRenderStore.setState({ job: null, starting: false, cancelling: false, error: null });
  storage = Object.fromEntries(mutations.map(name => [name, vi.fn(async () => ({ success: false, error: 'test stops before reload' }))]));
  storage.selectDirectory = vi.fn(async () => '/selected');
  storage.validateDataDir = vi.fn(async () => ({ valid: true }));
  storage.getCacheSize = vi.fn(async () => ({ total: 0 }));
  vi.stubGlobal('window', { storageManager: storage });
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(handlers.flatMap(handler => ['starting', 'running'].map(state => [handler, state] as const)))('%s blocks %s film tasks before touching storage', async (handler, state) => {
  useFilmRenderStore.setState(state === 'starting' ? { starting: true } : { job: runningJob });
  const callback = storageHandlers().get(handler);
  expect(callback).toBeTypeOf('function');
  await callback!();
  expect(storage.selectDirectory).not.toHaveBeenCalled();
  for (const name of mutations) expect(storage[name]).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/合成/));
});

it.each(handlers.slice(0, 3))('%s rechecks film state after the asynchronous directory dialog', async handler => {
  const callback = storageHandlers().get(handler)!;
  storage.selectDirectory.mockImplementation(async () => {
    useFilmRenderStore.setState({ starting: true });
    return '/selected';
  });
  await callback();
  for (const name of mutations) expect(storage[name]).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/合成/));
});

it('linking rechecks film state after asynchronous data-directory validation', async () => {
  storage.validateDataDir.mockImplementation(async () => {
    useFilmRenderStore.setState({ job: runningJob });
    return { valid: true };
  });
  await storageHandlers().get('handleLinkData')!();
  expect(storage.linkData).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/合成/));
});

it('terminal film tasks do not prevent cache maintenance', async () => {
  useFilmRenderStore.setState({ job: { ...runningJob, phase: 'cancelled' } });
  await storageHandlers().get('handleClearCache')!();
  expect(storage.clearCache).toHaveBeenCalledOnce();
});

it('does not reload away a film task started during the storage-success refresh delay', async () => {
  vi.useFakeTimers();
  const reload = vi.fn();
  vi.stubGlobal('window', { storageManager: storage, location: { reload } });
  vi.stubGlobal('localStorage', { removeItem: vi.fn() });
  vi.stubGlobal('indexedDB', { open: vi.fn(() => ({})) });
  storage.moveData.mockResolvedValue({ success: true, path: '/selected' });
  await storageHandlers().get('handleSelectStoragePath')!();
  useFilmRenderStore.setState({ starting: true });
  await vi.advanceTimersByTimeAsync(500);
  expect(reload).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/合成/));
});
