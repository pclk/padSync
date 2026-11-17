import { afterEach, beforeEach, expect, it } from 'vitest';
import { POST } from '@/app/api/sync/route';
import { parseServerTiming } from '@/lib/sync-debug';
import { configureAuthEnv, freshDb, req, sessionCookie } from './helpers/env';
let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async()=>{configureAuthEnv();db=await freshDb();});
afterEach(async()=>{await db.pg.close();});
it('adds per-request server timings only when explicitly requested, preserving the sync payload',async()=>{
 const session=sessionCookie();
 const body={since:0,changes:[],events:[]};
 const plain=await POST(req('/api/sync',{session,body}));
 expect(plain.headers.get('server-timing')).toBeNull();
 const detailed=await POST(req('/api/sync',{session,body,headers:{'x-padsync-debug':'1'}}));
 expect(await detailed.json()).toEqual(await plain.json());
 const metrics=parseServerTiming(detailed.headers.get('server-timing'));
 for(const phase of ['auth','parse','events','pull','serialize','total']) expect(metrics[phase]).toBeGreaterThanOrEqual(0);
 expect(detailed.headers.get('cache-control')).toBe('no-store');
});
it('times write and conflict readback phases without leaking entity content in headers',async()=>{
 const response=await POST(req('/api/sync',{session:sessionCookie(),body:{since:0,events:[],changes:[{id:'a',kind:'textbox',notebookId:'nb',parentId:'s',hlc:'001',deleted:0,data:{text:'PRIVATE_NOTE_TEXT'}}]},headers:{'x-padsync-debug':'1'}}));
 expect(response.status).toBe(200);
 const header=response.headers.get('server-timing');
 expect(header).not.toContain('PRIVATE_NOTE_TEXT');
 expect(parseServerTiming(header)).toMatchObject({write:expect.any(Number),conflicts:expect.any(Number)});
});
it('keeps debug requests behind the existing session and device-token boundary',async()=>{
 for(const [options,status] of [[{},401],[{bearer:'bridge'},403]] as const) {
  const response=await POST(req('/api/sync',{body:{since:0,changes:[],events:[]},headers:{'x-padsync-debug':'1'},...options}));
  expect(response.status).toBe(status);
 }
});
