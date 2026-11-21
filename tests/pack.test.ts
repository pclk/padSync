import { expect, it } from 'vitest';
import { parsePack, questionColumn, runLabel, runOf, type PackPage } from '@/lib/pack';
import type { SectionEntity } from '@/lib/types';

const page = (role: PackPage['role'], doc = 'Slides L01'): PackPage => ({ role, title: `${doc} · p1`, doc, chapter: 'L01' });
const section = (id: string): SectionEntity => ({ id, kind: 'section', notebookId: 'n', parentId: '', hlc: '', deleted: 0, dirty: 0, data: { order: 0, blocks: [], template: 'plain', minHeight: 100, createdAt: 0 } });

it('parses a page map, dropping bad refs and unknown roles', () => {
  const pack = parsePack({ format: 'padsync.pack', version: 1, file: 'a.pdf', files: ['a.pdf', 3], pages: [
    { role: 'question', title: 'PS 1 · p1', doc: 'PS 1', chapter: 'L01', material: [
      { kind: 'answer', label: 'PS 1 comments · p1', file: 'a.pdf', page: 4 },
      { kind: 'taught', label: 'L01 slide 10', file: 'a.pdf', page: 3 },
      { kind: 'answer', label: 'no page', file: 'a.pdf' },
      { kind: 'video', label: 'unknown kind', file: 'a.pdf', page: 2 },
    ] },
    { role: 'mystery' },
    null,
  ] });
  expect(pack?.files).toEqual(['a.pdf']);
  expect(pack?.pages[0].material).toEqual([{ kind: 'answer', label: 'PS 1 comments · p1', file: 'a.pdf', page: 4 }, { kind: 'taught', label: 'L01 slide 10', file: 'a.pdf', page: 3 }]);
  expect(pack?.pages[1]).toEqual({ role: 'material', title: '', doc: '', chapter: '' });
  expect(pack?.pages[2].role).toBe('material');
});

it('rejects anything that is not a version 1 page map', () => {
  expect(parsePack(null)).toBeNull();
  expect(parsePack({ format: 'padsync.pack', version: 2, file: 'a.pdf', pages: [] })).toBeNull();
  expect(parsePack({ format: 'other', version: 1, file: 'a.pdf', pages: [] })).toBeNull();
  expect(parsePack({ format: 'padsync.pack', version: 1, file: 'a.pdf', pages: {} })).toBeNull();
});

it('folds each run of non-question pages into one bar, and opens a run on request', () => {
  const s = ['m1', 'm2', 'q1', 'a1', 'blank', 'm3'].map(section);
  const pages = new Map<string, PackPage>([
    ['m1', page('material')], ['m2', page('material', 'Problem Set 01 comments')], ['q1', page('question')],
    ['a1', page('answer', 'PS comments')], ['m3', page('material')],
  ]); // "blank" is a page you added: not in the map, always shown
  const shut = questionColumn(s, pages, new Set());
  expect(shut.map((i) => (i.type === 'section' ? i.section.id : `${i.type}:${i.key}:${i.count}`))).toEqual(['collapsed:m1:2', 'q1', 'collapsed:a1:1', 'blank', 'collapsed:m3:1']);
  expect(shut[0].type === 'collapsed' && shut[0].label).toBe('Slides L01, Problem Set 01 comments');
  expect(runOf(shut, 'm2')).toBe('m1');
  expect(runOf(shut, 'q1')).toBeNull();
  const opened = questionColumn(s, pages, new Set(['m1']));
  expect(opened.slice(0, 3).map((i) => (i.type === 'section' ? `${i.section.id}@${i.index}` : i.type))).toEqual(['opened', 'm1@0', 'm2@1']);
});

it('names at most three documents in a run', () => {
  expect(runLabel(['A', 'B', 'B', 'C', 'D', 'E'].map((d) => page('material', d)))).toBe('A, B, C and 2 more');
});
