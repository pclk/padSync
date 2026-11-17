import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginSyncDebugRequest, clearSyncDebug, getSyncDebugSnapshot, parseServerTiming, recordRemoteApplied, recordSyncDebug, recordSyncPaint, setSyncDebugEnabled, updateSyncDebugRequest } from '@/lib/sync-debug';
beforeEach(() => { setSyncDebugEnabled(false); vi.useFakeTimers(); });
afterEach(() => { setSyncDebugEnabled(false); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('records nothing until enabled and clears recordings when disabled', () => {
  recordSyncDebug('test', 'off'); expect(beginSyncDebugRequest('off')).toBeUndefined();
  expect(getSyncDebugSnapshot()).toEqual({enabled:false,events:[],requests:[]});
  setSyncDebugEnabled(true); recordSyncDebug('browser', 'hidden', {visibility:'hidden'});
  expect(getSyncDebugSnapshot().events.at(-1)?.details.visibility).toBe('hidden');
  setSyncDebugEnabled(false); expect(getSyncDebugSnapshot().events).toHaveLength(0);
});
it('bounds event/request history and returns snapshots isolated from later updates', () => {
  setSyncDebugEnabled(true);
  for (let i=0;i<200;i++) recordSyncDebug('timer','scheduled',{delay:i});
  for (let i=0;i<60;i++) beginSyncDebugRequest('poll');
  const snapshot=getSyncDebugSnapshot();
  expect(snapshot.events).toHaveLength(150); expect(snapshot.requests).toHaveLength(40);
  snapshot.events[0].details.delay=-1;
  expect(getSyncDebugSnapshot().events[0].details.delay).not.toBe(-1);
  clearSyncDebug(); expect(getSyncDebugSnapshot().requests).toHaveLength(0);
});
it('parses numeric server phases without storing arbitrary header text', () => {
  expect(parseServerTiming('auth;dur=1.5, write;dur=12.25, total;dur=20')).toEqual({auth:1.5,write:12.25,total:20});
  expect(parseServerTiming('invalid, unknown;desc="private", total;dur=NaN')).toEqual({});
  expect(parseServerTiming(null)).toEqual({});
});
it('matches a received ink version to canvas work using a monotonic apply-to-paint duration', () => {
  setSyncDebugEnabled(true);
  const request=beginSyncDebugRequest('notification');
  const entity={id:'stroke-1',kind:'stroke',hlc:`${Date.now()-500}-0000-ipad`};
  recordRemoteApplied(request,[entity]);
  vi.advanceTimersByTime(75);
  recordSyncPaint([entity],3);
  const snapshot=getSyncDebugSnapshot();
  expect(snapshot.requests[0].remoteAgeMs).toBe(500);
  expect(snapshot.requests[0].applyToPaintMs).toBe(75);
  expect(snapshot.events.at(-1)?.details).toMatchObject({paintMs:3,receivedVersions:1,applyToPaintMs:75});
  recordSyncPaint([entity],1);
  expect(getSyncDebugSnapshot().events.at(-1)?.details.receivedVersions).toBe(0);
});
it('keeps a negative edit age visible as clock skew and discards updates to cleared traces', () => {
  setSyncDebugEnabled(true);
  const request=beginSyncDebugRequest('poll');
  recordRemoteApplied(request,[{id:'x',kind:'textbox',hlc:`${Date.now()+1000}-0000-mac`}]);
  expect(getSyncDebugSnapshot().requests[0].remoteAgeMs).toBe(-1000);
  clearSyncDebug(); updateSyncDebugRequest(request,{status:200});
  expect(getSyncDebugSnapshot().requests).toEqual([]);
});
