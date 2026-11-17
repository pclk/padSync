import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { GET, POST } from '@/app/api/pdfs/route';
import { pdfKey, ownedDocument } from '@/server/pdf-storage';
import { MAX_PDF_BYTES, PDF_PART_BYTES, pdfMetadata, pdfSections } from '@/lib/pdf-meta';
import { buildBundle, DEFAULT_CONTEXT } from '@/lib/context';
import { configureAuthEnv, freshDb, req, sessionCookie } from './helpers/env';
let db: Awaited<ReturnType<typeof freshDb>>;
let session: string;
const meta = { notebookId:'book',name:'Examples.pdf',size:24_300_000,pageCount:149,sha256:'a'.repeat(64) };
const send = vi.spyOn(S3Client.prototype,'send');
beforeEach(async () => {
  configureAuthEnv(); db = await freshDb(); session = sessionCookie();
  for (const [key,value] of Object.entries({ AWS_ENDPOINT_URL_S3:'https://storage.example.test',AWS_REGION:'us-east-2',AWS_ACCESS_KEY_ID:'test',AWS_SECRET_ACCESS_KEY:'secret',PDF_STORAGE_BUCKET:'pdfs' })) vi.stubEnv(key,value);
  send.mockReset(); send.mockResolvedValue({ UploadId:'upload' } as never);
});
afterEach(async () => { vi.unstubAllEnvs(); await db.pg.close(); });
async function create() { const r = await POST(req('/api/pdfs',{session,body:{ action:'create',...meta }})); expect(r.status).toBe(200); return r.json(); }
it('creates owner-scoped multipart PUT capabilities with metadata only',async () => {
  const result = await create(); expect(result.urls).toHaveLength(3);
  expect(result.urls[0]).toContain('X-Amz-Signature='); expect(result.urls[0]).toContain('partNumber=1');
  const row = await ownedDocument(db.sql,'PCLK',result.id); expect(row?.object_key).toBe(pdfKey('pclk',result.id)); expect(row?.ready).toBe(false);
  expect(pdfKey('pclk',result.id)).not.toBe(pdfKey('foreign',result.id)); expect(() => pdfKey('pclk','../bad')).toThrow();
  expect(await ownedDocument(db.sql,'foreign',result.id)).toBeUndefined();
  await db.sql.query('update notebook_pdfs set object_key=$1 where id=$2',[pdfKey('foreign',result.id),result.id]);
  expect(await ownedDocument(db.sql,'pclk',result.id)).toBeUndefined();
});
it('requires session, rejects device tokens, foreign owners and cross-origin writes',async () => {
  expect((await GET(req('/api/pdfs?id=x'))).status).toBe(401);
  expect((await POST(req('/api/pdfs',{session,bearer:'psd_test',body:{}}))).status).toBe(403);
  expect((await POST(req('/api/pdfs',{session,headers:{origin:'https://evil.test'},body:{}}))).status).toBe(403);
  const { id } = await create(); await db.sql.query('update notebook_pdfs set owner=$1 where id=$2',['foreign',id]);
  for (const action of ['complete','abort']) expect((await POST(req('/api/pdfs',{session,body:{action,id}}))).status).toBe(404);
  expect((await GET(req(`/api/pdfs?id=${id}`,{session}))).status).toBe(404);
});
it('validates metadata and reports missing storage',async () => {
  for (const patch of [{size:MAX_PDF_BYTES+1},{size:0},{pageCount:0},{pageCount:2001},{sha256:'bad'},{name:'\u0000.pdf'},{notebookId:'../book'}]) {
    expect(pdfMetadata.safeParse({...meta,...patch}).success).toBe(false);
    expect((await POST(req('/api/pdfs',{session,body:{action:'create',...meta,...patch}}))).status).toBe(400);
  }
  vi.stubEnv('PDF_STORAGE_BUCKET',''); expect((await POST(req('/api/pdfs',{session,body:{action:'create',...meta}}))).status).toBe(503);
});
it('checks complete part lengths, signature and object size before allowing downloads',async () => {
  const { id } = await create(); const complete = () => POST(req('/api/pdfs',{session,body:{action:'complete',id}}));
  send.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce({ Parts:[] } as never);
  expect((await complete()).status).toBe(400);
  send.mockResolvedValueOnce({ ContentLength:meta.size } as never).mockResolvedValueOnce({ Body:{transformToByteArray:async () => new TextEncoder().encode('bad!!')} } as never);
  expect((await complete()).status).toBe(400);
  expect((await GET(req(`/api/pdfs?id=${id}`,{session}))).status).toBe(404);
  send.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce({ Parts:Array.from({length:3},(_,i) => ({PartNumber:i+1,ETag:`etag${i}`,Size:Math.min(PDF_PART_BYTES,meta.size-i*PDF_PART_BYTES)})) } as never)
    .mockResolvedValueOnce({} as never).mockResolvedValueOnce({ContentLength:meta.size} as never).mockResolvedValueOnce({Body:{transformToByteArray:async () => new TextEncoder().encode('%PDF-')}} as never);
  expect((await complete()).status).toBe(200); expect((await ownedDocument(db.sql,'pclk',id))?.ready).toBe(true);
  const response = await GET(req(`/api/pdfs?id=${id}`,{session})); expect((await response.json()).url).toContain('X-Amz-Expires=300');
  expect((await POST(req('/api/pdfs',{session,body:{action:'abort',id}}))).status).toBe(409);
});
it('creates 149 tall sections with page text and stable page references; bounds invalid dimensions', () => {
  const sections = pdfSections('doc','Examples.pdf',Array.from({length:149},(_,i) => ({width:595,height:842,text:`Question ${i+1}`})));
  expect(sections).toHaveLength(149); expect(sections[148].pdf?.page).toBe(149); expect(sections[0].minHeight).toBe(1948);
  expect(() => pdfSections('doc','x',[])).toThrow(); expect(() => pdfSections('doc','x',[{width:0,height:1,text:''}])).toThrow();
  const inputs = sections.slice(0,2).map((data,i) => ({id:`s${i}`,data:{...data,order:i,createdAt:0},notes:[],lastActivity:0,render:{base64:'AAAA',width:1376,height:1948}}));
  const bundle = buildBundle({title:'Examples',sections:inputs},{...DEFAULT_CONTEXT,scope:'sections',sectionIds:['s1']});
  const md = bundle.files.find(f => f.path === 'notebook.md')!.text!;
  expect(md).toContain('Examples.pdf · page 2'); expect(md).toContain('Question 2'); expect(md).not.toContain('Question 1');
  expect(bundle.files.some(f => f.path.startsWith('renders/'))).toBe(true);
  expect(buildBundle({title:'Examples',sections:inputs,maxBytes:40},DEFAULT_CONTEXT).error).toBeTruthy();
});
it('aborts pending uploads, removes the object and metadata, and never downloads pending files',async () => {
  const { id } = await create();
  expect((await GET(req(`/api/pdfs?id=${id}`,{session}))).status).toBe(404);
  const response = await POST(req('/api/pdfs',{session,body:{action:'abort',id}}));
  expect(response.status).toBe(200);
  expect(send.mock.calls.slice(-2).map(c => c[0].constructor.name)).toEqual(['AbortMultipartUploadCommand','DeleteObjectCommand']);
  expect(await ownedDocument(db.sql,'pclk',id)).toBeUndefined();
});
