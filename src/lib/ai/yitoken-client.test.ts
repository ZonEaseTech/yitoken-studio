import { describe, expect, it, vi, afterEach } from 'vitest';
import { normalizeYitokenRoot, syncYitokenModels, generateYitokenVideo, generateYitokenImage, supportsYitokenFeature } from './yitoken-client';
import { DEFAULT_PROVIDERS } from '../api-key-manager';

afterEach(() => vi.unstubAllGlobals());
describe('YITOKEN public API contracts', () => {
  it('starts with a real YITOKEN provider and normalizes only HTTPS roots', () => {
    expect(DEFAULT_PROVIDERS[0]).toMatchObject({ platform: 'yitoken', baseUrl: 'https://yitoken.com.cn' });
    expect(normalizeYitokenRoot(' https://yitoken.com.cn/v1/ ')).toBe('https://yitoken.com.cn');
    for (const url of ['http://yitoken.com.cn', 'https://user:pass@yitoken.com.cn', 'https://yitoken.com.cn/?key=x', 'https://yitoken.com.cn/path']) expect(() => normalizeYitokenRoot(url)).toThrow();
  });
  it('syncs authenticated available models and merges only their public endpoint metadata', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (url.endsWith('/v1/models')) {
        expect(init?.headers).toEqual({ Authorization: 'Bearer fake-test-key' });
        return Response.json({ data: [{ id: 'seedance-2.0-mini' }, { id: 'unknown-model' }] });
      }
      return Response.json({ data: [{ model_name: 'seedance-2.0-mini', supported_endpoint_types: ['openai', 'openai-video'] }, { model_name: 'not-accessible', supported_endpoint_types: ['openai'] }] });
    }));
    const result = await syncYitokenModels('https://yitoken.com.cn/v1', 'fake-test-key');
    expect(requests).toEqual(['https://yitoken.com.cn/v1/models', 'https://yitoken.com.cn/api/pricing']);
    expect(result.models).toEqual(['seedance-2.0-mini', 'unknown-model']);
    expect(result.endpoints).toEqual({ 'seedance-2.0-mini': ['openai', 'openai-video'] });
    expect(supportsYitokenFeature('video_generation', 'seedance-2.0-mini', result.endpoints)).toBe(true);
    expect(supportsYitokenFeature('chat', 'seedance-2.0-mini', result.endpoints)).toBe(false);
    expect(supportsYitokenFeature('video_generation', 'unknown-model', result.endpoints)).toBe(false);
  });
  it('submits once to /v1/videos preserving model, options and first/last/reference roles then polls encoded ID', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe('https://yitoken.com.cn/v1/videos');
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ model: 'seedance-2.0-mini', prompt: 'test', seconds: '5', metadata: { ratio: '16:9', resolution: '720p', generate_audio: false, camera_fixed: true } });
        expect(body.metadata.content).toEqual([
          { type: 'image_url', image_url: { url: 'https://storage.test/first.png' }, role: 'first_frame' },
          { type: 'image_url', image_url: { url: 'https://storage.test/last.png' }, role: 'last_frame' },
          { type: 'image_url', image_url: { url: 'https://storage.test/ref.png' }, role: 'reference_image' },
        ]);
        return Response.json({ id: 'task/a', status: 'queued' });
      }
      expect(url).toBe('https://yitoken.com.cn/v1/videos/task%2Fa');
      return Response.json({ status: 'completed', progress: 100, url: 'https://storage.test/video.mp4' });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await generateYitokenVideo({ baseUrl: 'https://yitoken.com.cn', apiKey: 'fake-test-key', model: 'seedance-2.0-mini', prompt: 'test', duration: 5, aspectRatio: '16:9', resolution: '720p', enableAudio: false, cameraFixed: true, images: [{url:'https://storage.test/first.png',role:'first_frame'},{url:'https://storage.test/last.png',role:'last_frame'},{url:'https://storage.test/ref.png',role:'reference_image'}] }, { pollInterval: 0 });
    expect(result).toEqual({ url: 'https://storage.test/video.mp4', taskId: 'task/a' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never resubmits on ambiguous network or upstream submit failure', async () => {
    for (const failure of [new TypeError('network failed'), Response.json({}, { status: 503 })]) {
      const fetcher = vi.fn(async () => { if (failure instanceof Error) throw failure; return failure; });
      vi.stubGlobal('fetch', fetcher);
      await expect(generateYitokenVideo({ baseUrl: 'https://yitoken.com.cn', apiKey: 'fake-test-key', model: 'seedance-2.0-mini', prompt: 'test' })).rejects.toThrow(/重复|提交/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds polling and preserves task ID on timeout without repeating a charge', async () => {
    const fetcher = vi.fn(async (_: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { id: 'known-task' } : { status: 'in_progress', progress: 25 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(generateYitokenVideo({ baseUrl: 'https://yitoken.com.cn', apiKey: 'fake-test-key', model: 'seedance-2.0-mini', prompt: 'test' }, { pollInterval: 0, maxPollAttempts: 2 })).rejects.toThrow(/known-task/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects unsupported reference URLs and options before a billable request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(generateYitokenVideo({ baseUrl: 'https://yitoken.com.cn', apiKey: 'fake-test-key', model: 'seedance-2.0-mini', prompt: 'test', images: [{url:'local-image://private.png',role:'first_frame'}] })).rejects.toThrow(/上传/);
    await expect(generateYitokenVideo({ baseUrl: 'https://yitoken.com.cn', apiKey: 'fake-test-key', model: 'seedance-2.0-mini', prompt: 'test', duration: 500 })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses image generation protocol, preserves image references and has no retry submission', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://yitoken.com.cn/v1/images/generations');
      expect(JSON.parse(init.body as string)).toMatchObject({ model: 'seedream-5.0-lite', n: 1, size: '2048x2048', image: ['https://storage.test/ref.png'] });
      return Response.json({ data: [{ url: 'https://storage.test/generated.png' }] });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await generateYitokenImage({ baseUrl:'https://yitoken.com.cn',apiKey:'fake-test-key',model:'seedream-5.0-lite',prompt:'test',size:'2048x2048',referenceImages:['https://storage.test/ref.png'] })).toEqual({imageUrl:'https://storage.test/generated.png'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it('rejects unsafe dimensions and blank prompt before charging for an image', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const size of ['NaNxNaN', '-1x2048', '999999x999999']) {
    await expect(generateYitokenImage({baseUrl:'https://yitoken.com.cn',apiKey:'fake-test-key',model:'seedream-5.0-lite',prompt:'test',size})).rejects.toThrow();
  }
  await expect(generateYitokenImage({baseUrl:'https://yitoken.com.cn',apiKey:'fake-test-key',model:'seedream-5.0-lite',prompt:'   '})).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('surfaces terminal failure or missing download URL without resubmitting', async () => {
  for (const task of [{status:'failed',error:{message:'server detail'}},{status:'completed'}]) {
    const fetcher=vi.fn(async (_:string, init?:RequestInit)=>Response.json(init?.method==='POST'?{id:'known-task'}:task));vi.stubGlobal('fetch',fetcher);
    await expect(generateYitokenVideo({baseUrl:'https://yitoken.com.cn',apiKey:'fake-test-key',model:'seedance-2.0-mini',prompt:'test'},{pollInterval:0})).rejects.toThrow(/known-task/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  }
});
it('marks ambiguous submission failures as unsafe for any outer automatic retry', async () => {
  for (const failure of [new TypeError('synthetic disconnect'), Response.json({}, {status:503})]) {
    vi.stubGlobal('fetch',vi.fn(async()=>{if(failure instanceof Error)throw failure;return failure;}));
    const error=await generateYitokenVideo({baseUrl:'https://yitoken.com.cn',apiKey:'fake-key',model:'seedance-2.0-mini',prompt:'test'}).catch(error=>error);
    expect(error).toMatchObject({submissionAttempted:true,retrySafe:false});
  }
});
it('never allows an automatic paid resubmission for YITOKEN even when failure is local post-processing',async()=>{
  const {canAutomaticallyResubmitGeneration}=await import('./yitoken-client');
  expect(canAutomaticallyResubmitGeneration('yitoken',new Error('Image slice failed after submission'))).toBe(false);
  expect(canAutomaticallyResubmitGeneration('custom',Object.assign(new Error('503'),{retrySafe:false}))).toBe(false);
  expect(canAutomaticallyResubmitGeneration('custom',new Error('503'))).toBe(true);
});
