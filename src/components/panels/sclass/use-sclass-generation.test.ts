import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAPIConfigStore } from '@/stores/api-config-store';
import { useSClassGeneration } from './use-sclass-generation';

// Fixture only substitutes project subscriptions/actions. The Hook, prompt builder,
// feature router, key manager, shared video API and YITOKEN HTTP client stay real.
const fixture = vi.hoisted(() => ({
  scene: {id:1, duration:5, videoPrompt:'Synthetic test prompt', characterIds:[], imageDataUrl:'', imageHttpUrl:''},
  group: {id:'test-group',name:'Synthetic group',sceneIds:[1],totalDuration:5,imageRefs:[],videoRefs:[],audioRefs:[],mergedPrompt:'Synthetic test prompt',history:[],sortIndex:0,generationType:'new'},
  groupStatus: vi.fn(), singleStatus: vi.fn(),
}));
vi.mock('@/stores/sclass-store', () => ({useSClassStore: () => ({
  activeProjectId:'synthetic-project',getProjectData:()=>({config:{defaultDuration:5},shotGroups:[fixture.group]}),
  updateGroupVideoStatus:fixture.groupStatus,updateSingleShotVideo:fixture.singleStatus,
  addGroupHistory:vi.fn(),updateConfig:vi.fn(),updateShotGroup:vi.fn(),addShotGroup:vi.fn(),
})}));
vi.mock('@/stores/director-store', () => ({
  useActiveDirectorProject:()=>({splitScenes:[fixture.scene]}),
  useDirectorStore:Object.assign(() => ({}),{getState:()=>({activeProjectId:'synthetic-project',projects:{'synthetic-project':{storyboardConfig:{aspectRatio:'16:9',videoResolution:'720p'}}}})}),
}));
let generation: ReturnType<typeof useSClassGeneration>;
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fixture.group,{imageRefs:[],videoRefs:[],audioRefs:[]});
  const id = `test-provider-${++sequence}`;
  useAPIConfigStore.setState({providers:[{id,platform:'yitoken',name:'YITOKEN',baseUrl:'https://yitoken.com.cn',apiKey:'fake-key-a,fake-key-b',model:['seedance-2.0-mini']}],modelEndpointTypes:{'seedance-2.0-mini':['openai-video']},featureBindings:{script_analysis:null,character_generation:null,scene_generation:null,video_generation:[`${id}:seedance-2.0-mini`],image_understanding:null,chat:null,freedom_image:null,freedom_video:null}});
  function Probe() { generation = useSClassGeneration(); return null; }
  renderToStaticMarkup(createElement(Probe));
});
afterEach(()=>vi.unstubAllGlobals());
describe('real outer Sclass generation never repeats a YITOKEN charge',()=>{
  for (const mode of ['group','single'] as const) {
    for (const failure of ['http503','network'] as const) {
      it(`${mode} with two keys submits only once after ${failure}`, async()=>{
        const posts: string[]=[];
        vi.stubGlobal('fetch',vi.fn(async(url:string, init?:RequestInit)=>{
          if (init?.method==='POST') posts.push(url);
          if (failure==='network') throw new TypeError('Synthetic network disconnect');
          return Response.json({}, {status:503});
        }));
        if (mode==='group') {
          const result=await generation.generateGroupVideo(fixture.group as any);
          expect(result.success).toBe(false); expect(result.error).toMatch(/提交/);
          expect(fixture.groupStatus).toHaveBeenLastCalledWith('test-group',expect.objectContaining({videoStatus:'failed'}));
        } else {
          expect(await generation.generateSingleShot(1)).toBe(false);
          expect(fixture.singleStatus).toHaveBeenLastCalledWith(1,expect.objectContaining({videoStatus:'failed'}));
        }
        expect(posts).toEqual(['https://yitoken.com.cn/v1/videos']);
      });
    }
  }
});

it('group preserves character/scene reference roles rather than making every extra image a last frame', async()=>{
  Object.assign(fixture.group,{imageRefs:[{id:'char',type:'image',tag:'@Image1',localUrl:'https://assets.test/character.png',httpUrl:null,fileName:'character.png',fileSize:0,duration:null,purpose:'character_ref'},{id:'scene',type:'image',tag:'@Image2',localUrl:'https://assets.test/scene.png',httpUrl:null,fileName:'scene.png',fileSize:0,duration:null,purpose:'scene_ref'}]});
  let body:any;
  vi.stubGlobal('fetch',vi.fn(async(_:string, init?:RequestInit)=>{body=JSON.parse(init?.body as string);return Response.json({}, {status:503});}));
  await generation.generateGroupVideo(fixture.group as any);
  expect(body.metadata.content).toEqual([{type:'image_url',image_url:{url:'https://assets.test/character.png'},role:'reference_image'},{type:'image_url',image_url:{url:'https://assets.test/scene.png'},role:'reference_image'}]);
});
it('group refuses an unavailable video upload instead of dropping the reference and charging for text-only generation', async()=>{
  Object.assign(fixture.group,{imageRefs:[],videoRefs:[{id:'clip',type:'video',tag:'@Video1',localUrl:'local-video://private/clip.mp4',httpUrl:null,fileName:'clip.mp4',fileSize:0,duration:5,purpose:'general'}]});
  const posts:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')posts.push(url);return Response.json({}, {status:503});}));
  const result=await generation.generateGroupVideo(fixture.group as any);
  expect(result.success).toBe(false); expect(result.error).toMatch(/上传|图床|素材/);expect(posts).toEqual([]);
});
