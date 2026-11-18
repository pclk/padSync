import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginSyncDebugRequest, clearSyncDebug, formatSyncDebugReport, syncDebugStats, getSyncDebugSnapshot, parseServerTiming, recordRemoteApplied, recordSyncDebug, recordSyncPaint, setSyncDebugEnabled, updateSyncDebugRequest } from '@/lib/sync-debug';
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

it('keeps the last 300 edit requests past the 40-request cap', () => {
  setSyncDebugEnabled(true);
  for (let i=0;i<350;i++) {
    const r=beginSyncDebugRequest('local edit'); updateSyncDebugRequest(r,{totalMs:1,pushedContent:1});
    beginSyncDebugRequest('poll');
  }
  const kept=getSyncDebugSnapshot().requests;
  expect(kept.filter(r=>r.pushedContent)).toHaveLength(300);
  expect(kept.filter(r=>!r.pushedContent)).toHaveLength(40);
  expect(syncDebugStats()[2].count).toBe(300);
});

it('averages edits by received, sent and all, and formats a pasteable report', () => {
  setSyncDebugEnabled(true);
  const empty=beginSyncDebugRequest('poll'); updateSyncDebugRequest(empty,{totalMs:9999,httpMs:9999});
  const recv=beginSyncDebugRequest('realtime notification'); updateSyncDebugRequest(recv,{totalMs:600,httpMs:400,newConnection:true,connectMs:200,appliedContent:1,remoteAgeMs:1000});
  const sent=beginSyncDebugRequest('local edit'); updateSyncDebugRequest(sent,{totalMs:100,httpMs:60,newConnection:false,connectMs:0,pushedContent:2,sendAgeMs:300});
  const [received,sentGroup,all]=syncDebugStats();
  expect(received).toMatchObject({count:1,newConnections:1}); expect(received.avg.httpMs).toBe(400);
  expect(sentGroup.avg.sendAgeMs).toBe(300);
  expect(all.count).toBe(2); expect(all.avg.totalMs).toBe(350); expect(all.max.httpMs).toBe(400);
  const report=formatSyncDebugReport(['Device: test']);
  expect(report).toContain('Device: test'); expect(report).toContain('Received edits n=1');
  expect(report).toContain('realtime notification'); expect(report).toContain('2 of up to 300 edit requests');
  // The empty poll is listed but left out of the averages.
  expect(all.max.totalMs).toBe(600);
});
