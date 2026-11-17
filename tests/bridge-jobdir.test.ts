import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXT_FILE,
  IMAGE_FILE,
  JOB_DIR_PREFIX,
  agentCommand,
  buildAgentPrompt,
  prepareJobDir,
  removeJobDir,
  runAgent,
  sweepStaleJobDirs,
  withJobDir,
  type AgentCommand,
} from "../bridge/lib.ts";
import { PNG_DATA_URL } from "./helpers/env";

// How job inputs reach the agent: written to a private per-job directory, referenced by path in
// the prompt, and removed afterwards whatever happens.

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "padsync-jobdir-test-")));
});
const entries = () => readdir(root);

describe("job directory", () => {
  it("writes the image and context into a fresh private directory", async () => {
    const d = await prepareJobDir({ image: PNG_DATA_URL, context: "Evaluate $x$" }, root);
    expect(dirname(d.dir)).toBe(root);
    expect(basename(d.dir).startsWith(JOB_DIR_PREFIX)).toBe(true);
    expect(d.image).toBe(join(d.dir, IMAGE_FILE));
    expect(d.context).toBe(join(d.dir, CONTEXT_FILE));
    expect((await readFile(d.image!)).subarray(1, 4).toString()).toBe("PNG");
    expect(await readFile(d.context!, "utf8")).toBe("Evaluate $x$");
    expect((await stat(d.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(d.image!)).mode & 0o777).toBe(0o600);
    await removeJobDir(d.dir);
    expect(await entries()).toEqual([]);
  });

  it("only writes the inputs a job has", async () => {
    const d = await prepareJobDir({ image: null, context: "" }, root);
    expect(d.image).toBeUndefined();
    expect(d.context).toBeUndefined();
    expect(await readdir(d.dir)).toEqual([]);
  });

  it("gives concurrent jobs separate directories", async () => {
    const ds = await Promise.all(Array.from({ length: 8 }, (_, i) => prepareJobDir({ image: null, context: `job ${i}` }, root)));
    expect(new Set(ds.map((d) => d.dir)).size).toBe(8);
    for (const [i, d] of ds.entries()) expect(await readFile(d.context!, "utf8")).toBe(`job ${i}`);
  });

  it("removes the directory if writing an input fails", async () => {
    await expect(prepareJobDir({ image: "data:image/svg+xml;base64,AAAA", context: "x" }, root)).rejects.toThrow(/PNG/);
    expect(await entries()).toEqual([]);
  });

  it("keeps file names fixed whatever the job contains", async () => {
    const d = await prepareJobDir({ image: null, context: "../../etc/passwd\n/etc/passwd" }, root);
    expect(await readdir(d.dir)).toEqual([CONTEXT_FILE]);
    expect(d.context).toBe(join(d.dir, CONTEXT_FILE));
  });

  it("withJobDir removes the directory on success and on error", async () => {
    let seen = "";
    expect(await withJobDir({ image: PNG_DATA_URL, context: "c" }, async (d) => ((seen = d.dir), 42), root)).toBe(42);
    await expect(stat(seen)).rejects.toThrow();
    await expect(
      withJobDir({ image: null, context: "c" }, async (d) => {
        seen = d.dir;
        throw new Error("agent blew up");
      }, root),
    ).rejects.toThrow("agent blew up");
    await expect(stat(seen)).rejects.toThrow();
    expect(await entries()).toEqual([]);
  });

  it("removeJobDir never throws", async () => {
    expect(await removeJobDir(join(root, "does-not-exist"))).toBe(true);
  });
});

describe("sweeping leftovers from a killed bridge", () => {
  it("removes only old padsync job directories", async () => {
    const now = Date.now();
    const old = join(root, `${JOB_DIR_PREFIX}old`);
    const fresh = join(root, `${JOB_DIR_PREFIX}fresh`);
    const other = join(root, "someone-elses-dir");
    for (const d of [old, fresh, other]) await mkdir(d);
    await writeFile(join(old, CONTEXT_FILE), "secret solution");
    const hourAgo = new Date(now - 2 * 3600_000);
    await utimes(old, hourAgo, hourAgo);
    await utimes(other, hourAgo, hourAgo);
    expect(await sweepStaleJobDirs(3600_000, root, now)).toBe(1);
    expect((await entries()).sort()).toEqual([`${JOB_DIR_PREFIX}fresh`, "someone-elses-dir"]);
  });

  it("does not follow symlinks or touch plain files", async () => {
    const target = await mkdtemp(join(tmpdir(), "padsync-sweep-target-"));
    await writeFile(join(target, "keep.txt"), "keep");
    await symlink(target, join(root, `${JOB_DIR_PREFIX}link`));
    await writeFile(join(root, `${JOB_DIR_PREFIX}file`), "x");
    expect(await sweepStaleJobDirs(0, root, Date.now() + 1000)).toBe(0);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  it("tolerates a missing root", async () => {
    expect(await sweepStaleJobDirs(0, join(root, "nope"))).toBe(0);
  });
});

describe("path-only prompt", () => {
  const files = { image: "/tmp/padsync-job-x/section.png", context: "/tmp/padsync-job-x/context.md" };

  it("never inlines the inputs, only their paths", () => {
    const p = buildAgentPrompt("Is line 3 right?", files);
    expect(p).not.toContain("base64");
    expect(p).not.toContain("data:image");
    expect(p).toContain(files.image);
    expect(p).toContain(files.context);
    expect(p).toMatch(/Read tool/);
    expect(p.length).toBeLessThan(1500);
  });

  it("codex: the image is attached, so the prompt says not to open it again", () => {
    const p = buildAgentPrompt("Q?", files, "codex");
    expect(p).toMatch(/attached image/i);
    expect(p).toMatch(/don't open it again/);
    expect(p).toContain(files.context);
    expect(buildAgentPrompt("Q?", { image: files.image }, "codex")).toMatch(/Look at the attached image/);
    expect(agentCommand("codex", {}, true).args).toContain(IMAGE_FILE);
  });
});

describe("cleanup around a real agent run", () => {
  const fakeAgent = async (body: string): Promise<AgentCommand> => {
    const bin = join(await mkdtemp(join(tmpdir(), "padsync-fake-")), "agent.mjs");
    await writeFile(bin, `#!/usr/bin/env node\n${body}\n`);
    await chmod(bin, 0o755);
    return { bin, args: [], parse: (l) => (l ? { text: l } : null) };
  };

  it("removes the directory after the agent is cancelled", async () => {
    const command = await fakeAgent(`console.log((await import("node:fs")).readdirSync(".").sort().join(",")); setTimeout(() => {}, 60000);`);
    const ac = new AbortController();
    let dir = "";
    let seen = "";
    const r = await withJobDir({ image: PNG_DATA_URL, context: "c" }, (d) => {
      dir = d.dir;
      return runAgent({ cwd: d.dir, prompt: "", command, timeoutMs: 30_000, signal: ac.signal, onText: (t) => ((seen = t), ac.abort()) });
    }, root);
    expect(r.status).toBe("cancelled");
    expect(seen).toBe(`${CONTEXT_FILE},${IMAGE_FILE}`);
    await expect(stat(dir)).rejects.toThrow();
    expect(await entries()).toEqual([]);
  });

  it("removes the directory after the agent fails to start", async () => {
    const r = await withJobDir({ image: null, context: "c" }, (d) =>
      runAgent({ cwd: d.dir, prompt: "", command: { bin: join(root, "missing-bin"), args: [], parse: () => null }, timeoutMs: 5000, onText: () => {} }), root);
    expect(r.status).toBe("error");
    expect(await entries()).toEqual([]);
  });
});
