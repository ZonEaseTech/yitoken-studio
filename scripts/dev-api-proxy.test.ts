import { afterEach, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { validateProxyTarget, validateProxyOrigin, filterProxyHeaders, apiCorsProxyPlugin } from './dev-api-proxy';

test('development proxy only forwards HTTPS to the declared YITOKEN host', () => {
  expect(validateProxyTarget('https://yitoken.com.cn/v1/models')).toBe('https://yitoken.com.cn/v1/models');
  for (const url of ['http://yitoken.com.cn/v1/models','https://127.0.0.1/admin','https://yitoken.com.cn.evil.test/','https://user:pass@yitoken.com.cn/','file:///etc/passwd','https://yitoken.com.cn/v1/models?apiKey=secret']) expect(() => validateProxyTarget(url)).toThrow();
});
test('a remote webpage cannot call the local development proxy', () => {
  expect(validateProxyOrigin('http://127.0.0.1:5173', '127.0.0.1:5173')).toBe(true);
  expect(validateProxyOrigin('http://localhost:5173', 'localhost:5173')).toBe(true);
  for (const origin of ['https://evil.test','http://localhost:9876','null']) expect(validateProxyOrigin(origin,'localhost:5173')).toBe(false);
  expect(validateProxyOrigin(undefined,'localhost:5173')).toBe(false);
});
test('proxy never forwards arbitrary host/cookie headers', () => {
  expect(filterProxyHeaders({Authorization:'Bearer user-key', 'Content-Type':'application/json',Cookie:'secret',Host:'private.internal'})).toEqual({Authorization:'Bearer user-key', 'Content-Type':'application/json'});
});

test('Vite development entry config loads the same guarded proxy instead of an undefined helper', async () => {
  const { loadConfigFromFile } = await import('vite');
  const config = await loadConfigFromFile({command:'serve',mode:'development'}, 'vite.config.ts');
  expect(config?.config.server?.host).toBe('127.0.0.1');
  expect(config?.config.plugins?.flat().some(plugin => plugin && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'yitoken-local-development-proxy')).toBe(true);
});

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
function middlewareFixture(body: Buffer | null = Buffer.from('fixture request')) {
 let middleware:any;const plugin=apiCorsProxyPlugin();(plugin.configureServer as any)({middlewares:{use:(_path:string,handler:any)=>{middleware=handler;}}});
 const request=Object.assign(new PassThrough(),{headers:{origin:'http://localhost:5173',host:'localhost:5173','x-proxy-headers':JSON.stringify({Authorization:'Bearer synthetic-test-key'})},method:'POST',url:'/?url='+encodeURIComponent('https://yitoken.com.cn/v1/chat/completions')});
 if(body!==null)request.end(body);
 const writes:Array<{status:number;headers:any}>=[];const result:{body?:Buffer|string;headersSent:boolean;writableEnded:boolean}={headersSent:false,writableEnded:false};
 const response={...result,writeHead(status:number,headers:any){writes.push({status,headers});if(this.headersSent)throw new Error('fixture headers already sent');this.headersSent=true;return this;},end(body?:Buffer|string){result.body=body;this.writableEnded=true;}};
 return {request,response,writes,result,run:()=>middleware(request,response)};
}
test('middleware sends upstream headers only after bounded response succeeds and never writes them twice on body failure',async()=>{
 const fixture=middlewareFixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.error(new Error('synthetic upstream body failure'));}}),{status:200})));
 await expect(fixture.run()).resolves.toBeUndefined();expect(fixture.writes).toHaveLength(1);expect(fixture.writes[0].status).toBe(502);expect(String(fixture.result.body)).not.toContain('synthetic upstream body failure');
});
test('middleware refuses oversized upstream response without forwarding partial content or success headers',async()=>{
 const fixture=middlewareFixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(64*1024*1024+1));controller.close();}}),{status:200})));
 await fixture.run();expect(fixture.writes.map(item=>item.status)).toEqual([502]);expect(Buffer.byteLength(fixture.result.body||'')).toBeLessThan(1024);
});
test('one total deadline covers a stalled incoming request before any upstream POST',async()=>{
 vi.useFakeTimers();const fixture=middlewareFixture(null);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 let settled=false;const pending=fixture.run().then(()=>{settled=true;});await vi.advanceTimersByTimeAsync(120001);const settledAtDeadline=settled;
 if(!settled)fixture.request.destroy(new Error('fixture cleanup'));
 await pending;expect(settledAtDeadline).toBe(true);expect(fetcher).not.toHaveBeenCalled();expect(fixture.writes.map(item=>item.status)).toEqual([502]);
});
test('response reading shares the incoming request deadline rather than receiving another 120 seconds',async()=>{
 vi.useFakeTimers();const fixture=middlewareFixture(null);let cancelled=false,settled=false;let upstreamController:ReadableStreamDefaultController<Uint8Array>;
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){upstreamController=controller;},cancel(){cancelled=true;}}),{status:200})));
 const pending=fixture.run().then(()=>{settled=true;});await vi.advanceTimersByTimeAsync(90000);fixture.request.end('delayed request');await vi.advanceTimersByTimeAsync(30001);const settledAtTotalDeadline=settled;
 // Old code needs its synthetic response to settle so the failing test leaves no live promise.
 if(!settled)upstreamController!.close(); // Assert before waiting on an implementation with no bounded response reader.
 await pending;expect(settledAtTotalDeadline).toBe(true);expect(cancelled).toBe(true);expect(fixture.writes.map(item=>item.status)).toEqual([502]);
});
test('failed-response cancellation cleanup cannot keep the proxy alive beyond its deadline',async()=>{
 vi.useFakeTimers();const fixture=middlewareFixture();let settled=false;
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({cancel(){return new Promise<void>(()=>{});}}))));
 const pending=fixture.run().then(()=>{settled=true;});await vi.advanceTimersByTimeAsync(120001);
 expect(settled).toBe(true);await pending;expect(fixture.writes.map(item=>item.status)).toEqual([502]);
});
test('middleware forwards one bounded successful response and rejects oversized incoming body before fetching',async()=>{
 const fixture=middlewareFixture();const fetcher=vi.fn(async(_target:string,options:RequestInit)=>{expect(options.redirect).toBe('error');expect(options.signal).toBeInstanceOf(AbortSignal);expect(options.headers).toEqual({Authorization:'Bearer synthetic-test-key'});expect(Buffer.from(options.body as Buffer).toString()).toBe('fixture request');return new Response('upstream body',{status:201,headers:{'Content-Type':'text/plain'}});});vi.stubGlobal('fetch',fetcher);
 await fixture.run();expect(fetcher).toHaveBeenCalledTimes(1);expect(fixture.writes.map(item=>item.status)).toEqual([201]);expect(Buffer.from(fixture.result.body||'').toString()).toBe('upstream body');
 const oversized=middlewareFixture(Buffer.alloc(64*1024*1024+1));fetcher.mockClear();await oversized.run();expect(fetcher).not.toHaveBeenCalled();expect(oversized.writes.map(item=>item.status)).toEqual([502]);
});
