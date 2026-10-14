import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@opencut/ai-core/services/prompt-compiler', () => ({ PromptCompiler: class {} }));
vi.mock('@opencut/ai-core/api/task-poller', () => ({ TaskPoller: class {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

it('legacy screenplay worker does not submit credentials to unimplemented backend routes or log config', async () => {
  const worker = { onmessage: undefined as any, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('./ai-worker');
  await worker.onmessage({ data: {
    type: 'GENERATE_SCREENPLAY', payload: { prompt: 'scene', config: { apiKey: 'TEST_SECRET_NOT_REAL', sceneCount: 1 } },
  } });
  expect(fetch).not.toHaveBeenCalled();
  expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'SCREENPLAY_ERROR', payload: expect.objectContaining({ error: expect.stringContaining('尚未接入') }),
  }));
  expect(JSON.stringify(log.mock.calls)).not.toContain('TEST_SECRET_NOT_REAL');
});

it('production HTML enforces self-only scripts and blocks embedded executable content', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] || '';
  expect(policy).toContain("script-src 'self';");
  expect(policy).toContain("object-src 'none';");
  expect(policy).toContain("frame-src 'none';");
  expect(policy).toContain("worker-src 'self' blob:;");
  expect(policy).not.toContain('unsafe-eval');
  expect(policy).not.toMatch(/script-src[^;]*(https:|'unsafe-inline')/);
});
