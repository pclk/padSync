import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncDebugDetails, SyncDebugOverlay } from '@/components/SyncDebugOverlay';
import { DEFAULT_SYNC_CONFIG } from '@/lib/sync-policy';
import { SYNC_DEBUG_KEY, SYNC_DEBUG_DEFAULT, readBoolSetting, writeBoolSetting } from '@/lib/settings';
import { clearSyncDebug, getSyncDebugSnapshot, setSyncDebugEnabled } from '@/lib/sync-debug';
beforeEach(() => { setSyncDebugEnabled(true); clearSyncDebug(); });
afterEach(() => { setSyncDebugEnabled(false); vi.unstubAllGlobals(); });
it('persists the per-device preference and defaults to off', () => {
  const values=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  expect(SYNC_DEBUG_DEFAULT).toBe(false);
  expect(readBoolSetting(SYNC_DEBUG_KEY,SYNC_DEBUG_DEFAULT)).toBe(false);
  writeBoolSetting(SYNC_DEBUG_KEY,true); expect(readBoolSetting(SYNC_DEBUG_KEY,false)).toBe(true);
});
it('shows hidden-state diagnosis, measured phases and uncertainty without exposing content', () => {
  const timing={...DEFAULT_SYNC_CONFIG,realtimeStatus:'suspended' as const,effectivePollMs:60000,start:0,end:0,edits:[],requests:1,traceTruncated:false,status:'synced' as const,running:false,again:false,failures:0,retryAt:0,nextDueAt:null,scheduledReason:'hidden poll',configCheckedAt:null};
  const selected={id:1,at:1000,trigger:'hidden poll',visibility:'hidden',phase:'Done',queueMs:60000,timerLateMs:500,totalMs:100,status:200,server:{auth:5,total:50},remoteAgeMs:1200};
  const html=renderToStaticMarkup(createElement(SyncDebugDetails,{snapshot:getSyncDebugSnapshot(),timing,environment:{device:'mac',visibility:'hidden',focused:false,online:true,standalone:false},selected}));
  expect(html).toContain('Realtime is deliberately disconnected');
  expect(html).toContain('hidden poll interval'); expect(html).toContain('Server timing (inside HTTP time)');
  expect(html).toContain('Timer late (part of wait)'); expect(html).toContain('clock skew');
  expect(html).toContain('No extra sync requests');
});

it('hides the overlay by default and exposes the same toggle on Settings', async () => {
  const values=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  vi.stubGlobal('window',{location:{search:''},addEventListener(){},removeEventListener(){}});
  expect(renderToStaticMarkup(createElement(SyncDebugOverlay))).toBe('');
  const {default:SettingsView}=await import('@/components/SettingsView');
  const toggle=(html:string)=>/<label[^>]*>(?:(?!<\/label>)[\s\S])*Show sync debug menu(?:(?!<\/label>)[\s\S])*<\/label>/.exec(html)![0];
  expect(toggle(renderToStaticMarkup(createElement(SettingsView)))).not.toContain('checked=""');
  writeBoolSetting(SYNC_DEBUG_KEY,true);
  expect(toggle(renderToStaticMarkup(createElement(SettingsView)))).toContain('checked=""');
  expect(renderToStaticMarkup(createElement(SyncDebugOverlay))).toContain('aria-label="Sync debug menu"');
});
