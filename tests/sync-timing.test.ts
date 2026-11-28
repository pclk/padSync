import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FAST_SYNC_CONFIG, replaySyncRequests } from '@/lib/sync-policy';
const realtime = vi.hoisted(() => ({ notify: undefined as ((seq?: number) => void) | undefined, status: undefined as ((status: 'live' | 'fallback') => void) | undefined }));
vi.mock('@/lib/sync-realtime', () => ({ startRealtime: (notify: (seq?: number) => void, status: (status: 'live' | 'fallback') => void) => {
 realtime.notify = notify; realtime.status = status; return () => {};
} }));
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
 sync.requestSync(); await vi.advanceTimersByTimeAsync(1500); sync.requestSync();
 await vi.advanceTimersByTimeAsync(500);
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
 expect(replaySyncRequests([],0,60000,400)).toBe(12);
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
 await vi.advanceTimersByTimeAsync(59999);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
});

it('advances a pending receive poll when faster settings arrive',async()=>{
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 sync.setSyncConfig({visiblePollMs:250});
 await vi.advanceTimersByTimeAsync(249);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
});
it('uses configurable hidden polling and retry delay',async()=>{
 Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
 sync.setSyncConfig({hiddenPollMs:1000,retryBaseMs:500});
 fetchMock.mockImplementation(async(url:string)=>url==='/api/sync-config'?Response.json({debounceMs:400}):new Response('',{status:500}));
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 await vi.advanceTimersByTimeAsync(499);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
});

it('uses the configured interval for successful hidden-tab receives',async()=>{
 Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
 sync.setSyncConfig({hiddenPollMs:1000});
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 await vi.advanceTimersByTimeAsync(999);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
});

it('sends edits with zero delay and retains all zero controls',async()=>{
 fetchMock.mockImplementation(async(url:string)=>url==='/api/sync-config'?Response.json({debounceMs:0,visiblePollMs:0,hiddenPollMs:0,retryBaseMs:0}):Response.json({changes:[],cursor:0,more:false}));
 sync.setSyncConfig({debounceMs:0,visiblePollMs:0,hiddenPollMs:0,retryBaseMs:0});
 sync.requestSync(); await vi.advanceTimersByTimeAsync(0);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 expect(sync.getSyncTiming()).toMatchObject({debounceMs:0,visiblePollMs:0,hiddenPollMs:0,retryBaseMs:0});
 expect(replaySyncRequests([],0,1000,0,0)).toBe(Infinity);
});

it('slows recovery polling while realtime is connected and restores configured polling on failure',async()=>{
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 realtime.status!('live');
 expect(sync.getSyncTiming().effectivePollMs).toBe(30000);
 // An already scheduled deadline remains intact to protect queued edits.
 await vi.advanceTimersByTimeAsync(5000);
 await vi.advanceTimersByTimeAsync(29999);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
 await vi.advanceTimersByTimeAsync(1);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(3);
 realtime.status!('fallback');
 await vi.advanceTimersByTimeAsync(5000);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(4);
});
it('a realtime notification during a request schedules serialized reconciliation',async()=>{
 let release!:()=>void; let count=0;
 fetchMock.mockImplementation(async(url:string)=>{
  if(url==='/api/sync-config') return Response.json({debounceMs:400});
  count++; if(count===1) await new Promise<void>(resolve=>{release=resolve;});
  return Response.json({changes:[],cursor:0,more:false});
 });
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 realtime.notify!(); await vi.advanceTimersByTimeAsync(0); expect(count).toBe(1);
 release(); await vi.advanceTimersByTimeAsync(1); expect(count).toBe(2);
 expect(sync.getSyncTiming().edits).toHaveLength(0);
});
it('skips a notification for a change it already has, such as its own push echoing back',async()=>{
 let release!:()=>void; let count=0;
 fetchMock.mockImplementation(async(url:string)=>{
  if(url==='/api/sync-config') return Response.json({debounceMs:400});
  count++; if(count===2) await new Promise<void>(resolve=>{release=resolve;});
  return Response.json({changes:[],cursor:count===1?7:9,more:false});
 });
 sync.startSync(); await vi.advanceTimersByTimeAsync(0); expect(count).toBe(1);
 realtime.notify!(7); await vi.advanceTimersByTimeAsync(0); expect(count).toBe(1);
 // The echo of the push in flight lands before its response: decided once the response is in.
 sync.requestSync(0); await vi.advanceTimersByTimeAsync(0); expect(count).toBe(2);
 realtime.notify!(9); release(); await vi.advanceTimersByTimeAsync(1); expect(count).toBe(2);
 realtime.notify!(10); await vi.advanceTimersByTimeAsync(0); expect(count).toBe(3);
});
it('slows polling right down once nothing has happened for five minutes, so Neon can scale to zero',async()=>{
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 expect(sync.getSyncTiming().effectivePollMs).toBe(5000);
 await vi.advanceTimersByTimeAsync(5*60_000+1);
 expect(sync.getSyncTiming().effectivePollMs).toBe(600_000);
 sync.requestSync();
 expect(sync.getSyncTiming().effectivePollMs).toBe(5000);
});
it('syncs as if hidden while a native notebook covers the page',async()=>{
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 expect(sync.getSyncTiming().effectivePollMs).toBe(5000);
 (window as unknown as {padsyncCovered:boolean}).padsyncCovered=true; window.dispatchEvent(new Event('padsync-native-cover'));
 expect(sync.getSyncTiming().effectivePollMs).toBe(60000);
 (window as unknown as {padsyncCovered:boolean}).padsyncCovered=false; window.dispatchEvent(new Event('padsync-native-cover'));
 await vi.advanceTimersByTimeAsync(0);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(2);
});

it('batches edits with the fast preset while keeping moderate fallback and retry intervals',async()=>{
 sync.setSyncConfig(FAST_SYNC_CONFIG); sync.requestSync();
 await vi.advanceTimersByTimeAsync(25); sync.requestSync();
 await vi.advanceTimersByTimeAsync(24); expect(fetchMock).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);
 expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/sync')).toHaveLength(1);
 expect(sync.getSyncTiming()).toMatchObject({visiblePollMs:5000,hiddenPollMs:60000,retryBaseMs:2000});
});

it('records scheduled wait and request phases only when debug is enabled, without extra requests',async()=>{
 const debug=await import('@/lib/sync-debug'); debug.setSyncDebugEnabled(true);
 fetchMock.mockImplementation(async(url:string)=>url==='/api/sync-config'?Response.json({debounceMs:50}):Response.json({changes:[],cursor:7,more:false},{headers:{'Server-Timing':'auth;dur=2, pull;dur=15, total;dur=20'}}));
 sync.setSyncConfig(FAST_SYNC_CONFIG); sync.requestSync();
 await vi.advanceTimersByTimeAsync(50);
 const recorded=debug.getSyncDebugSnapshot().requests;
 expect(recorded).toHaveLength(1);
 expect(recorded[0]).toMatchObject({trigger:'local edit',visibility:'visible',queueMs:50,timerLateMs:0,phase:'Done',status:200,pushed:0,pulled:0,cursor:7,server:{auth:2,pull:15,total:20}});
 for(const key of ['readMs','encodeMs','httpMs','decodeMs','applyMs','totalMs'] as const) expect(recorded[0][key]).toBeGreaterThanOrEqual(0);
 const calls=fetchMock.mock.calls as unknown as [string,RequestInit][];
 expect(calls.find(call=>call[0]==='/api/sync')?.[1].headers).toMatchObject({'x-padsync-debug':'1'});
 debug.setSyncDebugEnabled(false); sync.requestSync(0); await vi.advanceTimersByTimeAsync(0);
 expect(debug.getSyncDebugSnapshot().requests).toHaveLength(0);
 expect(calls.filter(call=>call[0]==='/api/sync')).toHaveLength(2);
 expect((calls.filter(call=>call[0]==='/api/sync').at(-1)![1].headers as Record<string,string>)['x-padsync-debug']).toBeUndefined();
});
it('records hidden browser transitions and the hidden poll deadline',async()=>{
 const debug=await import('@/lib/sync-debug'); debug.setSyncDebugEnabled(true);
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 Object.assign(document,{visibilityState:'hidden'}); document.dispatchEvent(new Event('visibilitychange'));
 await vi.advanceTimersByTimeAsync(5000);
 const snapshot=debug.getSyncDebugSnapshot();
 expect(snapshot.events.some(event=>event.kind==='browser'&&event.details.visibility==='hidden')).toBe(true);
 expect(snapshot.events.some(event=>event.message==='Sync scheduled'&&event.details.trigger==='hidden poll'&&event.details.delayMs===60000)).toBe(true);
 expect(snapshot.requests.at(-1)?.visibility).toBe('hidden');
});
it('records response parsing failures with the actual phase',async()=>{
 const debug=await import('@/lib/sync-debug'); debug.setSyncDebugEnabled(true);
 fetchMock.mockImplementation(async(url:string)=>url==='/api/sync-config'?Response.json({debounceMs:400}):new Response('invalid JSON'));
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 expect(debug.getSyncDebugSnapshot().requests[0].phase).toContain('Error during Read response body + JSON (SyntaxError)');
 expect(sync.getSyncState().status).toBe('error');
});

it('holds a sync during a stroke and sends it the moment the stroke ends',async()=>{
 const { setInking } = await import('@/lib/activity');
 sync.startSync(); await vi.advanceTimersByTimeAsync(0);
 const syncs=()=>fetchMock.mock.calls.filter(c=>c[0]==='/api/sync').length;
 const before=syncs();
 setInking(true); sync.requestSync(); await vi.advanceTimersByTimeAsync(400);
 expect(syncs()).toBe(before);
 setInking(false); await vi.advanceTimersByTimeAsync(0);
 expect(syncs()).toBe(before+1);
 // A gesture that never ends still lets the sync through after the cap (send delay 400 + 3000).
 setInking(true); sync.requestSync(); await vi.advanceTimersByTimeAsync(3300);
 expect(syncs()).toBe(before+1);
 await vi.advanceTimersByTimeAsync(100);
 expect(syncs()).toBe(before+2);
 setInking(false);
});
