import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAPIConfigStore } from '@/stores/api-config-store';
import { generateCharacterImage, submitGridImageRequest } from './image-generator';
import { generateFreedomImage, generateFreedomVideo } from '@/lib/freedom/freedom-api';
import { callVideoGenerationApi } from '@/components/panels/director/use-video-generation';

vi.setConfig({ testTimeout: 20000 });
afterEach(() => vi.unstubAllGlobals());
const configure = () => useAPIConfigStore.setState({ providers: [{id:'yt',platform:'yitoken',name:'YITOKEN',apiKey:'fake-test-key',baseUrl:'https://yitoken.com.cn',model:['seedream-5.0-lite','seedance-2.0-mini']}],modelEndpointTypes:{'seedream-5.0-lite':['image-generation'],'seedance-2.0-mini':['openai-video']},featureBindings:{script_analysis:null,chat:null,image_understanding:null,character_generation:['yt:seedream-5.0-lite'],scene_generation:['yt:seedream-5.0-lite'],video_generation:['yt:seedance-2.0-mini'],freedom_image:['yt:seedream-5.0-lite'],freedom_video:['yt:seedance-2.0-mini']} });
describe('YITOKEN integration calls real declared paths', () => {
  it('character and grid images preserve references in Seedream image, not image_urls', async () => {
    configure(); const requests: any[] = [];
    vi.stubGlobal('fetch',vi.fn(async (url:string,init:RequestInit) => {expect(url).toBe('https://yitoken.com.cn/v1/images/generations'); requests.push(JSON.parse(init.body as string)); return Response.json({data:[{url:'https://assets.test/result.png'}]}); }));
    await generateCharacterImage({prompt:'test',referenceImages:['https://assets.test/ref.png']});
    await submitGridImageRequest({model:'seedream-5.0-lite',prompt:'grid',aspectRatio:'1:1',apiKey:'fake-test-key',baseUrl:'https://yitoken.com.cn',referenceImages:['https://assets.test/ref.png']});
    expect(requests).toHaveLength(2); for (const request of requests) expect(request.image).toEqual(['https://assets.test/ref.png']);
  });
  it('freedom image never retries an ambiguous 503 submission', async () => {
    configure(); const fetcher=vi.fn(async()=>Response.json({}, {status:503})); vi.stubGlobal('fetch',fetcher);
    await expect(generateFreedomImage({prompt:'test'})).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('freedom video never retries an ambiguous 503 submission', async () => {
    configure(); const fetcher=vi.fn(async()=>Response.json({}, {status:503})); vi.stubGlobal('fetch',fetcher);
    await expect(generateFreedomVideo({prompt:'test',model:'seedance-2.0-mini',duration:5})).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('director video submission does not lose HTTPS reference images or retry 503', async () => {
    configure(); const requests: Array<{url:string, body:any}> = [];
    const fetcher=vi.fn(async(url:string,init:RequestInit) => { requests.push({url,body:JSON.parse(init.body as string)}); return Response.json({}, {status:503}); }); vi.stubGlobal('fetch',fetcher);
    await expect(callVideoGenerationApi('fake-test-key','test',5,'16:9',[{url:'https://assets.test/ref.png',role:'first_frame'}],undefined,undefined,'yitoken','720p',undefined,undefined,undefined,undefined,undefined,['https://assets.test/character.png'])).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(requests[0].url).toBe('https://yitoken.com.cn/v1/videos');
    expect(requests[0].body.metadata.content).toContainEqual({type:'image_url',image_url:{url:'https://assets.test/ref.png'},role:'first_frame'});
    expect(requests[0].body.metadata.content).toContainEqual({type:'image_url',image_url:{url:'https://assets.test/character.png'},role:'reference_image'});
  });
});
it('refuses unvalidated negative-prompt mode without sending a paid image request', async () => {
  configure(); const fetcher=vi.fn(async()=>Response.json({data:[{url:'https://assets.test/result.png'}]})); vi.stubGlobal('fetch',fetcher);
  await expect(generateFreedomImage({prompt:'test',negativePrompt:'bad'})).rejects.toThrow(/尚未|不支持/);
  await expect(generateCharacterImage({prompt:'test',negativePrompt:'bad'})).rejects.toThrow(/尚未|不支持/);
  expect(fetcher).not.toHaveBeenCalled();
});
it('director cancellation before image submission never sends a paid POST', async()=>{
  configure();const posts:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts.push(url);return Response.json({data:[{url:'https://assets.test/result.png'}]});}));
  const {callImageGenerationApi}=await import('@/components/panels/director/use-image-generation');
  await expect(callImageGenerationApi('fake-test-key','test','16:9',[],undefined,AbortSignal.abort())).rejects.toThrow();
  expect(posts).toEqual([]);
});
it('director reference preparation rejects unreadable material rather than returning a partial list',async()=>{
  const {processReferenceImages}=await import('@/components/panels/director/use-image-generation');
  await expect(processReferenceImages(['https://assets.test/good.png','local-image://missing/ref.png'])).rejects.toThrow(/素材|图片|读取/);
});
it('script chat on YITOKEN never repeats an HTTP 503 or paid reasoning-only result',async()=>{
  useAPIConfigStore.setState({modelEndpointTypes:{...useAPIConfigStore.getState().modelEndpointTypes,'gpt-6.1-sol':['openai']}});
  const {callChatAPI}=await import('@/lib/script/script-parser');
  for(const outcome of ['503','reasoning'] as const){
    vi.useFakeTimers();const posts:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts.push(url);return outcome==='503'?Response.json({}, {status:503}):Response.json({choices:[{message:{content:'',reasoning_content:'reasoning only'}}],usage:{completion_tokens:4096,completion_tokens_details:{reasoning_tokens:4096}}});}));
    const pending=callChatAPI('system','user',{apiKey:'fake-key-a,fake-key-b',provider:'openai',baseUrl:'https://yitoken.com.cn',model:'gpt-6.1-sol'}).catch(error=>error);
    await vi.runAllTimersAsync();const error=await pending;vi.useRealTimers();
    expect(error).toBeInstanceOf(Error);expect(posts).toEqual(['https://yitoken.com.cn/v1/chat/completions']);
  }
});
it('legacy shot entry points submit YITOKEN image/video only once to declared paths',async()=>{
  configure(); const {generateShotImage,generateShotVideo}=await import('@/lib/script/shot-generator');
  for(const media of ['image','video'] as const){
    vi.useFakeTimers();const posts:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts.push(url);return Response.json({}, {status:503});}));
    const shot={id:'synthetic-shot',imagePrompt:'test',videoPrompt:'test',duration:5} as any;
    const config={apiKey:'fake-key',provider:'yitoken',baseUrl:'https://yitoken.com.cn',model:media==='image'?'seedream-5.0-lite':'seedance-2.0-mini'};
    const pending=(media==='image'?generateShotImage(shot,config):generateShotVideo(shot,'https://assets.test/ref.png',config)).catch(error=>error);
    await vi.runAllTimersAsync();expect(await pending).toBeInstanceOf(Error);vi.useRealTimers();
    expect(posts).toEqual([media==='image'?'https://yitoken.com.cn/v1/images/generations':'https://yitoken.com.cn/v1/videos']);
  }
});
it('shared retry helper respects an explicit unsafe-submission marker',async()=>{
  const {retryOperation}=await import('@/lib/utils/retry');
  vi.useFakeTimers();const operation=vi.fn(async()=>{throw Object.assign(new Error('503'),{retrySafe:false,submissionAttempted:true});});
  const pending=retryOperation(operation).catch(error=>error);await vi.runAllTimersAsync();await pending;vi.useRealTimers();
  expect(operation).toHaveBeenCalledTimes(1);
});

it('legacy standalone screenplay UI clearly states the entry point is unavailable',async()=>{
  const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
  const {ScreenplayInput}=await import('@/components/panels/director/screenplay-input');
  const html=renderToStaticMarkup(createElement(ScreenplayInput,{}));
  expect(html).toContain('旧剧本入口未接入');
});
it('active Director storyboard scene-video workflow submits only once to the declared YITOKEN route',async()=>{
  configure();const {generateSceneVideos}=await import('@/lib/storyboard/storyboard-service');
  const posts:string[]=[];vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts.push(url);return Response.json({}, {status:503});}));
  const pending=generateSceneVideos([{id:1,imageDataUrl:'https://assets.test/ref.png',videoPrompt:'test'}],{aspectRatio:'16:9',apiKey:'fake-key',provider:'yitoken',baseUrl:'https://yitoken.com.cn',model:'seedance-2.0-mini'});
  await vi.runAllTimersAsync();expect((await pending).size).toBe(0);vi.useRealTimers();
  expect(posts).toEqual(['https://yitoken.com.cn/v1/videos']);
});
