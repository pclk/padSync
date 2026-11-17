import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as list, POST as create } from '@/app/api/attachments/route';
import { GET, PUT, POST, DELETE, PATCH } from '@/app/api/attachments/[id]/route';
import { configureAuthEnv, freshDb, req, params, sessionCookie } from './helpers/env';
import { parseSelectedPages } from '@/lib/persistent-attachment-meta';
import { getPersistentPdfBlob, uploadPersistentPdf } from '@/lib/persistent-attachments';
import type { PersistentPdf } from '@/lib/persistent-attachments';
let db: Awaited<ReturnType<typeof freshDb>>;
let session: string;
beforeEach(async () => { configureAuthEnv(); db = await freshDb(); session = sessionCookie(); });
afterEach(async () => { vi.unstubAllGlobals(); await db.pg.close(); });
async function start(size = 9) {
 const r = await create(req('/api/attachments', { session, body: { notebookId: 'book', name: 'Lecture 日本.pdf', size } }));
 expect(r.status).toBe(201); return (await r.json()).attachment as PersistentPdf;
}
function put(id: string, bytes = '%PDF-test', cookie = session) {
 return PUT(new NextRequest(`https://pad.test/api/attachments/${id}?part=0`, { method: 'PUT', headers: { cookie }, body: bytes }), params({id}));
}
it('persists PDF independently of jobs and restores metadata and bytes in a new device session', async () => {
 const meta = await start(); expect((await (await list(req('/api/attachments?notebookId=book', {session}))).json()).attachments).toEqual([]);
 expect((await put(meta.id)).status).toBe(200);
 expect((await POST(req(`/api/attachments/${meta.id}`, {method:'POST', session}), params({id:meta.id}))).status).toBe(200);
 const second = sessionCookie();
 const found = (await (await list(req('/api/attachments?notebookId=book', {session:second}))).json()).attachments;
 expect(found).toEqual([meta]); expect(meta.sourceFilename).toBe('Lecture 日本.pdf');
 expect(await (await GET(req(`/api/attachments/${meta.id}?part=0`, {session:second}), params({id:meta.id}))).text()).toBe('%PDF-test');
 expect((await (await list(req('/api/attachments?notebookId=else', {session}))).json()).attachments).toEqual([]);
 expect((await DELETE(req(`/api/attachments/${meta.id}`, {method:'DELETE',session}),params({id:meta.id}))).status).toBe(204);
 expect((await db.sql.query('select * from lecture_pdf_parts')).length).toBe(0);
});
it('denies foreign owners for every item operation and refuses unauthenticated, bearer, and CSRF requests', async () => {
 const meta = await start();
 await db.sql.query('update lecture_pdfs set owner=$1 where id=$2',['someone-else',meta.id]);
 for (const handler of [GET, PUT, POST, DELETE, PATCH]) expect((await handler(req(`/api/attachments/${meta.id}?part=0`,{session}),params({id:meta.id}))).status).toBe(404);
 expect((await list(req('/api/attachments?notebookId=book'))).status).toBe(401);
 expect((await list(req('/api/attachments?notebookId=book',{session,bearer:'token'}))).status).toBe(403);
 expect((await create(req('/api/attachments',{session,body:{},headers:{origin:'https://evil.test'}}))).status).toBe(403);
});
it('rejects incomplete finalization, invalid signatures and part lengths; finalized content is immutable', async () => {
 const meta = await start(); const ctx = params({id:meta.id});
 expect((await POST(req('/api/attachments/x',{session,method:'POST'}),ctx)).status).toBe(409);
 expect((await put(meta.id,'not-a-pdf')).status).toBe(400);
 expect((await put(meta.id,'%PDF-')).status).toBe(400);
 expect((await put(meta.id,'%PDF-test-extra')).status).toBe(413);
 await put(meta.id); await POST(req('/api/attachments/x',{session,method:'POST'}),ctx);
 expect((await put(meta.id)).status).toBe(409);
});
it('normalizes page provenance and rejects invalid ranges', () => {
 expect(parseSelectedPages('3-5,1,3')).toEqual([1,3,4,5]); expect(parseSelectedPages('')).toBeUndefined();
 for (const value of ['0','5-3','1,','abc','1-10001']) expect(() => parseSelectedPages(value)).toThrow();
});
it('client cleans up failed uploads and never returns unavailable bytes', async () => {
 const mock = vi.fn().mockResolvedValueOnce(Response.json({attachment:{id:'x'}})).mockResolvedValueOnce(Response.json({error:'disk failure'},{status:500})).mockResolvedValueOnce(new Response(null,{status:204}));
 vi.stubGlobal('fetch', mock);
 await expect(uploadPersistentPdf('book',new File(['%PDF-test'],'lecture.pdf'))).rejects.toThrow('disk failure');
 expect(mock.mock.calls[2]).toEqual(['/api/attachments/x',{method:'DELETE'}]);
 mock.mockResolvedValueOnce(Response.json({error:'missing'},{status:404}));
 await expect(getPersistentPdfBlob({id:'x',size:9} as PersistentPdf)).rejects.toThrow('unavailable');
});
it('round trips multiple chunks through the client and authenticated routes', async () => {
 vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
   const url = new URL(input, 'https://pad.test');
   const request = new NextRequest(url, { ...init, signal: init?.signal ?? undefined, headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie: session } });
   const id = url.pathname.split('/')[3];
   if (!id) return init?.method === 'POST' ? create(request) : list(request);
   const handler = init?.method === 'PUT' ? PUT : init?.method === 'POST' ? POST : init?.method === 'DELETE' ? DELETE : GET;
   return handler(request, params({id}));
 });
 const original = new File(['%PDF-', new Uint8Array(1_800_003)], 'large.pdf', {type:'application/pdf'});
 const progress: number[] = [];
 const meta = await uploadPersistentPdf('book',original, n => progress.push(n));
 expect(progress).toEqual([1_800_000, original.size]);
 const restored = await getPersistentPdfBlob(meta);
 expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
});

it('associates a PDF with an accepted notebook while retaining its original notebook', async () => {
 const meta = await start(); await put(meta.id);
 await POST(req('/api/attachments/x',{session,method:'POST'}),params({id:meta.id}));
 const response = await PATCH(req('/api/attachments/x',{session,method:'PATCH',body:{notebookId:'accepted'}}),params({id:meta.id}));
 expect(response.status).toBe(200);
 for (const notebookId of ['book','accepted']) expect((await (await list(req(`/api/attachments?notebookId=${notebookId}`,{session}))).json()).attachments).toHaveLength(1);
});
it('expires abandoned uploads and cascades their stored chunks', async () => {
 const meta = await start(); await put(meta.id);
 await db.sql.query("update lecture_pdfs set created_at=now()-interval '25 hours' where id=$1",[meta.id]);
 await list(req('/api/attachments?notebookId=book',{session}));
 expect(await db.sql.query('select id from lecture_pdfs')).toHaveLength(0);
 expect(await db.sql.query('select attachment_id from lecture_pdf_parts')).toHaveLength(0);
});
