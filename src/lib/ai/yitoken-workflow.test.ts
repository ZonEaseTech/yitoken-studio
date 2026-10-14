import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAPIConfigStore } from '@/stores/api-config-store';
import { useScriptStore } from '@/stores/script-store';
import { calibrateEpisodeShots } from '@/lib/script/full-script-service';
import { extractStyleTokens } from './style-extractor';
// Only the staged algorithm is a deterministic fixture. Its first stage performs
// the real chat request; a later parsing failure must not restart that paid stage.
vi.mock('@/lib/script/shot-calibration-stages',()=>({calibrateShotsMultiStage:async()=>{
  const {callFeatureAPI}=await import('@/lib/ai/feature-router');
  await callFeatureAPI('script_analysis','stage 1 system','stage 1 user');
  throw new Error('Synthetic stage 2 parse failure after a paid first stage');
}}));
beforeEach(()=>{
  const values=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
  useAPIConfigStore.setState({providers:[{id:'workflow-yt',platform:'yitoken',name:'YITOKEN',apiKey:'fake-key',baseUrl:'https://yitoken.com.cn',model:['gpt-6.1-sol']}],modelEndpointTypes:{'gpt-6.1-sol':['openai']},concurrency:1,featureBindings:{script_analysis:['workflow-yt:gpt-6.1-sol'],chat:['workflow-yt:gpt-6.1-sol'],character_generation:null,scene_generation:null,video_generation:null,image_understanding:null,freedom_image:null,freedom_video:null}});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('does not restart a paid multistage calibration after a later stage fails',async()=>{
  useScriptStore.setState({projects:{'synthetic-project':{scriptData:{title:'Test',episodes:[{id:'episode',index:1,title:'Test'}],scenes:[]},shots:[{id:'shot',episodeId:'episode',actionSummary:'test',characterNames:[],duration:5}],episodeRawScripts:[],projectBackground:null,seriesMeta:null} as any}});
  const posts:string[]=[];vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts.push(url);return Response.json({choices:[{message:{content:'stage 1 result'}}]});}));
  const pending=calibrateEpisodeShots(1,'synthetic-project',{apiKey:'fake-key',provider:'yitoken',baseUrl:'https://yitoken.com.cn',model:'gpt-6.1-sol'});
  await vi.runAllTimersAsync();const result=await pending;
  expect(posts).toEqual(['https://yitoken.com.cn/v1/chat/completions']);expect(result.success).toBe(false);expect(result.calibratedCount).toBe(0);
});
it('text-only style extraction uses one compatible YITOKEN chat request without requiring unsupported vision',async()=>{
  const posts:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts.push(url);return Response.json({choices:[{message:{content:JSON.stringify({styleTokens:'oil painting',sceneTokens:'garden',category:'2d',summaryZh:'油画'})}}]});}));
  expect(await extractStyleTokens('oil painting')).toMatchObject({styleTokens:'oil painting',summaryZh:'油画'});
  expect(posts).toEqual(['https://yitoken.com.cn/v1/chat/completions']);
});
it('style references remain unavailable without a verified vision adapter and never become a text-only charge',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(extractStyleTokens('oil painting',['local-image://private/ref.png'])).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
});
it('batch parser failure after a successful YITOKEN request does not repeat the same paid batch',async()=>{
  const {processBatched}=await import('./batch-processor');
  const posts:string[]=[];vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts.push(url);return Response.json({choices:[{message:{content:'paid but malformed result'}}]});}));
  const pending=processBatched({items:[{id:'sample'}],feature:'chat',buildPrompts:()=>({system:'system',user:'user'}),parseResult:()=>{throw new Error('synthetic parse failure');}});
  await vi.runAllTimersAsync();const result=await pending;
  expect(posts).toEqual(['https://yitoken.com.cn/v1/chat/completions']);expect(result.failedBatches).toBe(1);expect(result.results.size).toBe(0);
});
