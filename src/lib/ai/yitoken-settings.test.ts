import { describe, expect, it, vi } from 'vitest';
import { useAPIConfigStore, DEFAULT_IMAGE_HOST_PROVIDERS } from '@/stores/api-config-store';
import { getFeatureConfig } from './feature-router';

describe('safe first-run settings and explicit routing', () => {
  it('initializes YITOKEN without any bundled key or enabled third-party upload', () => {
    const state = useAPIConfigStore.getState();
    expect(state.providers[0]).toMatchObject({platform:'yitoken',apiKey:''});
    expect(DEFAULT_IMAGE_HOST_PROVIDERS.every(host => !host.enabled)).toBe(true);
    expect(state.imageHostProviders.every(host => !host.enabled)).toBe(true);
  });
  it('never silently falls back to memefast when a feature has no binding', () => {
    useAPIConfigStore.setState({ providers:[{id:'legacy',platform:'memefast',name:'legacy',baseUrl:'https://memefast.top',apiKey:'fake-key',model:['legacy-model']}], featureBindings:{script_analysis:null,character_generation:null,scene_generation:null,video_generation:null,image_understanding:null,chat:null,freedom_image:null,freedom_video:null} });
    expect(getFeatureConfig('video_generation')).toBeNull();
  });
  it('synchronizes YITOKEN endpoints without leaking key into query or billing generation', async () => {
    const provider = {id:'yt',platform:'yitoken',name:'YITOKEN',baseUrl:'https://yitoken.com.cn',apiKey:'fake-key',model:[]};
    useAPIConfigStore.setState({providers:[provider]});
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).not.toBe('POST'); expect(url).not.toContain('fake-key');
      return Response.json(url.endsWith('/models') ? {data:[{id:'seedream-5.0-lite'}]} : {data:[{model_name:'seedream-5.0-lite',supported_endpoint_types:['openai','image-generation']}]});
    });
    vi.stubGlobal('fetch',fetcher);
    expect(await useAPIConfigStore.getState().syncProviderModels('yt')).toMatchObject({success:true,count:1});
    expect(useAPIConfigStore.getState().modelEndpointTypes['seedream-5.0-lite']).toEqual(['openai','image-generation']);
    vi.unstubAllGlobals();
  });
  it('does not execute a mismatched or unknown YITOKEN protocol binding', () => {
    useAPIConfigStore.setState({providers:[{id:'yt',platform:'yitoken',name:'YITOKEN',baseUrl:'https://yitoken.com.cn',apiKey:'fake-key',model:['seedance-2.0-mini','unknown']}],modelEndpointTypes:{'seedance-2.0-mini':['openai','openai-video']},featureBindings:{script_analysis:null,character_generation:null,scene_generation:null,video_generation:['yt:unknown'],image_understanding:null,chat:['yt:seedance-2.0-mini'],freedom_image:null,freedom_video:null}});
    expect(getFeatureConfig('video_generation')).toBeNull(); expect(getFeatureConfig('chat')).toBeNull();
  });
});

it('hook-style feature read returns the bound model, not the first model of a mixed provider', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { useFeatureConfig } = await import('./feature-router');
  useAPIConfigStore.setState({providers:[{id:'yt',platform:'yitoken',name:'YITOKEN',apiKey:'fake-key',baseUrl:'https://yitoken.com.cn',model:['gpt-6.1-sol','seedream-5.0-lite']}],modelEndpointTypes:{'gpt-6.1-sol':['openai'],'seedream-5.0-lite':['image-generation']},featureBindings:{script_analysis:null,character_generation:['yt:seedream-5.0-lite'],scene_generation:null,video_generation:null,image_understanding:null,chat:null,freedom_image:null,freedom_video:null}});
  function Diagnostic() { const config=useFeatureConfig('character_generation'); return createElement('output',null,config?.model); }
  expect(renderToStaticMarkup(createElement(Diagnostic))).toBe('<output>seedream-5.0-lite</output>');
});
it('rejects an incompatible model override before sending a billable chat request',async()=>{
  useAPIConfigStore.setState({providers:[{id:'override',platform:'yitoken',name:'YITOKEN',apiKey:'fake-key',baseUrl:'https://yitoken.com.cn',model:['gpt-6.1-sol','seedance-2.0-mini']}],modelEndpointTypes:{'gpt-6.1-sol':['openai'],'seedance-2.0-mini':['openai-video']},featureBindings:{script_analysis:null,character_generation:null,scene_generation:null,video_generation:null,image_understanding:null,chat:['override:gpt-6.1-sol'],freedom_image:null,freedom_video:null}});
  const fetcher=vi.fn(async()=>Response.json({choices:[{message:{content:'wrong model was submitted'}}]}));vi.stubGlobal('fetch',fetcher);
  const {callFeatureAPI}=await import('./feature-router');
  await expect(callFeatureAPI('chat','system','user',{modelOverride:'seedance-2.0-mini'})).rejects.toThrow(/适配|支持|模型/);
  expect(fetcher).not.toHaveBeenCalled();vi.unstubAllGlobals();
});
