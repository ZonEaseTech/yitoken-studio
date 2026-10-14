import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDirectorFiles, exportDirectorToFolder, exportProjectFiles, exportProjectToFolder } from './export-service';

vi.mock('@/lib/image-storage', () => ({ readImageAsBase64: vi.fn() }));

const scriptConfig = {
  projectName: 'demo', scriptData: { title: 'demo', language: 'zh', characters: [], scenes: [] },
  shots: [{ id: '1', index: 1, sceneRefId: '1', actionSummary: '', imageUrl: 'https://assets.example/bad.png' }],
  targetDuration: '60s', includeImages: true, includeVideos: false, format: 'folder' as const,
};
const directorConfig = {
  projectName: 'demo', scenes: [{ id: 0, imageDataUrl: 'https://assets.example/bad.png' }],
  includeImages: true, includeVideos: false, includeEndFrames: false,
};

describe('asset export failures', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {
      createElement: () => ({ click: vi.fn() }),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([
    ['script', () => exportProjectFiles(scriptConfig as any), 'demo_shot_001.png'],
    ['director', () => exportDirectorFiles(directorConfig as any), 'demo_scene_001.png'],
  ])('%s download rejects with exact missing filename, not all-complete', async (_name, run, filename) => {
    await expect(run()).rejects.toMatchObject({ failedFiles: [filename] });
  });

  it.each([
    ['script', exportProjectToFolder, scriptConfig, 'images/shot_001.png'],
    ['director', exportDirectorToFolder, directorConfig, 'images/scene_001.png'],
  ])('%s folder failure is reported without repeating downloads', async (_name, run, config, filename) => {
    const writable = { write: vi.fn(), close: vi.fn() };
    const directory = {
      getDirectoryHandle: vi.fn(),
      getFileHandle: vi.fn().mockResolvedValue({ createWritable: async () => writable }),
    };
    directory.getDirectoryHandle.mockResolvedValue(directory);
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockResolvedValue(directory) });
    const progress = vi.fn();
    await expect(run(config as any, progress)).rejects.toMatchObject({ failedFiles: [filename] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[progress.mock.calls.length - 1]?.[0].message).toContain('失败');
    expect(progress.mock.calls.some(([p]) => p.message === '导出完成')).toBe(false);
  });
});
