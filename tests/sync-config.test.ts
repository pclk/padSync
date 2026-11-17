import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from '@/server/db';
import { GET, PUT } from '@/app/api/sync-config/route';
import { configureAuthEnv, freshDb, req, sessionCookie } from './helpers/env';
let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async()=>{configureAuthEnv(); db=await freshDb();});
afterEach(async()=>{delete process.env.ALLOWED_GITHUB_LOGIN; await db.pg.close();});
it('persists the admin value and returns it to other authenticated devices',async()=>{
 const session=sessionCookie('PcLk');
 expect(await (await GET(req('/api/sync-config',{session}))).json()).toEqual({admin:true,debounceMs:400,visiblePollMs:2000,hiddenPollMs:15000,retryBaseMs:2000});
 expect((await PUT(req('/api/sync-config',{method:'PUT',session,body:{debounceMs:125}}))).status).toBe(200);
 expect((await (await GET(req('/api/sync-config',{session:sessionCookie()}))).json()).debounceMs).toBe(125);
});
it('rejects non-admin sessions, missing sessions, bearer tokens and foreign origins',async()=>{
 process.env.ALLOWED_GITHUB_LOGIN='other';
 expect((await PUT(req('/api/sync-config',{method:'PUT',session:sessionCookie('other'),body:{debounceMs:100}}))).status).toBe(403);
 delete process.env.ALLOWED_GITHUB_LOGIN;
 expect((await PUT(req('/api/sync-config',{method:'PUT',body:{debounceMs:100}}))).status).toBe(401);
 expect((await PUT(req('/api/sync-config',{method:'PUT',session:sessionCookie(),bearer:'x',body:{debounceMs:100}}))).status).toBe(403);
 expect((await PUT(req('/api/sync-config',{method:'PUT',session:sessionCookie(),headers:{origin:'https://evil.test'},body:{debounceMs:100}}))).status).toBe(403);
});
it('rejects invalid timing values without changing the stored setting',async()=>{
 for(const debounceMs of [-1,10001,1.5,'400',null]) expect((await PUT(req('/api/sync-config',{method:'PUT',session:sessionCookie(),body:{debounceMs}}))).status).toBe(400);
 expect((await (await GET(req('/api/sync-config',{session:sessionCookie()}))).json()).debounceMs).toBe(400);
});

it('persists all timing controls and preserves them on legacy debounce updates', async()=>{
 const session=sessionCookie();
 const config={debounceMs:100,visiblePollMs:250,hiddenPollMs:1000,retryBaseMs:500};
 expect(await (await PUT(req('/api/sync-config',{method:'PUT',session,body:config}))).json()).toEqual(config);
 await PUT(req('/api/sync-config',{method:'PUT',session,body:{debounceMs:200}}));
 expect(await (await GET(req('/api/sync-config',{session}))).json()).toEqual({...config,debounceMs:200,admin:true});
});
it('rejects invalid new fields and unknown keys', async()=>{
 for(const body of [{visiblePollMs:-1},{hiddenPollMs:-1},{retryBaseMs:-1},{visiblePollMs:30001},{hiddenPollMs:120001},{retryBaseMs:30001},{visiblePollMs:1.5},{hiddenPollMs:'2000'},{unknown:100},{},[]]) {
 expect((await PUT(req('/api/sync-config',{method:'PUT',session:sessionCookie(),body}))).status).toBe(400);
 }
});

it('saves and returns zero for every timing control', async()=>{
 const session=sessionCookie();
 const config={debounceMs:0,visiblePollMs:0,hiddenPollMs:0,retryBaseMs:0};
 expect(await (await PUT(req('/api/sync-config',{method:'PUT',session,body:config}))).json()).toEqual(config);
 expect(await (await GET(req('/api/sync-config',{session}))).json()).toEqual({...config,admin:true});
});

it('upgrades existing minimum constraints and preserves saved values',async()=>{
 const session=sessionCookie();
 await PUT(req('/api/sync-config',{method:'PUT',session,body:{debounceMs:125}}));
 for(const [column,min,max] of [['debounce_ms',100,10000],['visible_poll_ms',100,30000],['hidden_poll_ms',1000,120000],['retry_base_ms',250,30000]]) {
   await db.sql.query(`alter table sync_config drop constraint sync_config_${column}_check`);
   await db.sql.query(`alter table sync_config add constraint sync_config_${column}_check check(${column} between ${min} and ${max})`);
 }
 await migrate(db.sql);
 expect((await (await GET(req('/api/sync-config',{session}))).json()).debounceMs).toBe(125);
 expect((await PUT(req('/api/sync-config',{method:'PUT',session,body:{debounceMs:0,visiblePollMs:0,hiddenPollMs:0,retryBaseMs:0}}))).status).toBe(200);
});
