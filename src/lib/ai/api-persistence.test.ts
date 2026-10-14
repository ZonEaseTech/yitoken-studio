import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test('actual API store saves user configuration via the main-process encrypted bridge, never localStorage', async () => {
  const read = vi.fn(async () => ({ success: true, value: null }));
  const write = vi.fn(async (_value: string) => ({ success: true }));
  const plaintextWrite = vi.fn();
  vi.stubGlobal('window', {
    localStorage: { getItem: vi.fn(() => null), setItem: plaintextWrite, removeItem: vi.fn() },
    secureApiConfig: { read, write, remove: vi.fn(async () => ({ success: true })) },
  });
  vi.stubGlobal('localStorage', (window as any).localStorage);
  const { useAPIConfigStore } = await import('@/stores/api-config-store');
  await useAPIConfigStore.persist.rehydrate();
  const provider = useAPIConfigStore.getState().providers[0];
  useAPIConfigStore.getState().updateProvider({ ...provider, apiKey: 'fake-persistence-test-key' });
  await vi.waitFor(() => expect(write.mock.calls.some(([value]) => value.includes('fake-persistence-test-key'))).toBe(true));
  expect(plaintextWrite).not.toHaveBeenCalled();
});
