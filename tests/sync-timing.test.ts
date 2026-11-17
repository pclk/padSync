import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { replaySyncRequests } from '@/lib/sync-policy';
let sync: typeof import('@/lib/sync');
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async()=>{
 vi.useFakeTimers(); vi.resetModules();
 vi.stubGlobal('window',new EventTarget()); vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));
 vi.stubGlobal('navigator',{onLine:true});
 fetchMock=vi.fn(async(url:string)=>url==='/api/sync-config'?Response.json({debounceMs:400}):Response.json({changes:[],cursor:0,more:false}));
 vi.stubGlobal('fetch',fetchMock);
 sync=await import('@/lib/sync');
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
// Mock IndexedDB boundary so fake timers exercise scheduling rather than Dexie's own timers.
vi.mock('@/lib/db',()=>({db:{entities:{where:()=>({equals:()=>({limit:()=>({toArray:async()=>[]})})}),bulkGet:async()=>[]},events:{where:()=>({equals:()=>({limit:()=>({toArray:async()=>[]})})})},meta:{put:async()=>{}},transaction:async(...args:unknown[])=>await (args.at(-1) as ()=>Promise<void>)()},getMeta:async()=>0,setMeta:async()=>{}}));
it('does not postpone a scheduled push during sustained edits',async()=>{
 sync.requestSync(); await vi.advanceTimersByTimeAsync(300); sync.requestSync();
 await vi.advanceTimersByTimeAsync(100);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 expect(sync.getSyncTiming().edits).toHaveLength(2);
});
it('an immediate sync advances the deadline and later polling cannot delay it',async()=>{
 sync.requestSync(2000); sync.requestSync(0); sync.requestSync(10000);
 await vi.advanceTimersByTimeAsync(0);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
});
it('applies the configured window',async()=>{
 sync.setSyncDebounce(100); sync.requestSync();
 await vi.advanceTimersByTimeAsync(99); expect(fetchMock).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1); expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
});
it('backs off failures even while local edits continue',async()=>{
 fetchMock.mockImplementation(async()=>new Response('',{status:500}));
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 for(let i=0;i<10;i++){sync.requestSync();await vi.advanceTimersByTimeAsync(100);}
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1000);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
});
it('replays coalesced triggers and idle polls without inventing writes',()=>{
 expect(replaySyncRequests([],0,60000,400)).toBe(30);
 expect(replaySyncRequests([0,100,200,300],0,1000,400)).toBe(1);
 expect(replaySyncRequests([0,100,200,300],0,1000,100)).toBe(4);
 expect(replaySyncRequests([0,100],0,1000,400)).toBe(replaySyncRequests([0,100],0,1000,400));
});

it('serializes in-flight syncs and follows edits with a second request',async()=>{
 let release!:()=>void;
 let count=0;
 fetchMock.mockImplementation(async(url:string)=>{
   if(url==='/api/sync-config') return Response.json({debounceMs:400});
   count++;
   if(count===1) await new Promise<void>(r=>{release=r;});
   return Response.json({changes:[],cursor:0,more:false});
 });
 sync.requestSync(0); await vi.advanceTimersByTimeAsync(0);
 sync.requestSync(); await vi.advanceTimersByTimeAsync(400);
 expect(count).toBe(1);
 release(); await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(1);
 expect(count).toBe(2);
});
it('survives invalid response JSON and retries later',async()=>{
 fetchMock.mockImplementation(async(url:string)=>url==='/api/sync-config'?Response.json({debounceMs:400}):new Response('invalid'));
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 expect(sync.getSyncState().status).toBe('error');
 await vi.advanceTimersByTimeAsync(2000);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
});

it('does not send while offline and wakes immediately on reconnect',async()=>{
 vi.stubGlobal('navigator',{onLine:false});
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 expect(fetchMock).not.toHaveBeenCalled();
 expect(sync.getSyncState().status).toBe('offline');
 vi.stubGlobal('navigator',{onLine:true});
 window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
});
it('uses slower polling for hidden tabs',async()=>{
 Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 await vi.advanceTimersByTimeAsync(14999);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
});
