import { describe, expect, it } from "vitest";
import { importInlineFiles } from "@/lib/ai-import";

describe("lecture source instructions", () => {
  it("passes paths and selected page provenance without document bytes", () => {
    const files = importInlineFiles({request:"Explain the derivation",goals:["explain","skeleton"]}, [{name:"Lecture.pdf",sourceFilename:"Lecture.pdf",mime:"application/pdf",kind:"pdf",persistentId:"pdf-1",selectedPages:[2,4,5]}]);
    expect(files).toHaveLength(2);
    expect(files[1].text).toContain("lectures/01-lecture.pdf");
    expect(files[1].text).toContain("selected pages: 2, 4, 5");
    expect(files[1].text).toContain("attachment: pdf-1");
    expect(files[1].text).toContain("Use only the selected pages");
    expect(files[0].text).toContain("worked examples");
    expect(files.every(f=>!f.base64)).toBe(true);
  });
});

import { lectureSources } from '@/lib/lecture-sources';
it('snapshots original filenames and selected pages independently of later UI edits', () => {
  const file = { name: 'safe.pdf', sourceFilename: 'Original lecture.pdf', persistentId: 'pdf-1', selectedPages: [2, 3] };
  const sources = lectureSources([file]);
  file.selectedPages.push(4);
  expect(sources).toEqual([{ attachmentId: 'pdf-1', name: 'Original lecture.pdf', pages: [2, 3] }]);
});

import { chatPrompt } from '@/lib/ai-import';
it('preserves selected pages in the manual chat fallback', () => {
  expect(chatPrompt({request:'Explain',goals:['explain']},[{name:'Lecture.pdf',selectedPages:[2,4,5]}])).toContain('selected pages: 2, 4, 5');
});
