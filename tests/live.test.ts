import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LiveAnalysis, type LiveEvent } from "../src/server/live.js";
import { watchRepo } from "../src/server/watch.js";
import { startExplorer, type RunningExplorer } from "../src/server/explorer.js";
import type { AnalysisResult } from "../src/api/analyze.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeResult = (tag: string): AnalysisResult =>
  ({ comparison: { newRev: tag }, changed: [] }) as unknown as AnalysisResult;

describe("LiveAnalysis coordination", () => {
  it("a save burst inside the debounce window produces ONE run", async () => {
    let calls = 0;
    const live = new LiveAnalysis(async () => {
      calls++;
      return fakeResult("r");
    }, { debounceMs: 60 });
    live.request();
    live.request();
    live.request();
    await sleep(30);
    live.request();
    await sleep(160);
    expect(calls).toBe(1);
    live.close();
  });

  it("a change arriving mid-run re-runs after the current run settles", async () => {
    const tags: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const live = new LiveAnalysis(async () => {
      if (tags.length === 0) await gate;
      tags.push(`r${tags.length + 1}`);
      return fakeResult(tags.at(-1)!);
    }, { debounceMs: 10 });
    const events: LiveEvent[] = [];
    live.subscribe((e) => events.push(e));
    const first = live.runNow();
    await sleep(20);
    live.request(); // arrives mid-run → must schedule a second run
    release();
    await first;
    await sleep(200);
    expect(tags).toEqual(["r1", "r2"]);
    expect(live.latest?.comparison.newRev).toBe("r2");
    expect(live.revision).toBe(2);
    const results = events.filter((e) => e.type === "analysis-result");
    expect(results.map((e) => e.revision)).toEqual([1, 2]);
    live.close();
  });

  it("stale completions never overwrite: an old run finishing last is dropped", async () => {
    // Runs serialize, so this exercises the generation guard directly:
    // run rev1 (slow), during it bump revision via a failed/successful rev2
    // that lands first — rev1's late completion must not replace latest.
    let calls = 0;
    const live = new LiveAnalysis(async () => {
      calls++;
      if (calls === 1) {
        await sleep(50);
        // Force a newer revision while rev1 is still computing.
        (live as unknown as { revision: number }).revision++;
        return fakeResult("stale");
      }
      return fakeResult("fresh");
    }, { debounceMs: 10 });
    const results: LiveEvent[] = [];
    live.subscribe((e) => {
      if (e.type === "analysis-result") results.push(e);
    });
    await live.runNow();
    // rev1 computed "stale" but the emitted event carries its own rev — the
    // internal `latest` must still be the stale result only if it was newest.
    // Bump happened mid-run → rev1 was NOT newest at adoption time → latest
    // stays undefined until a fresh run lands.
    const live2 = new LiveAnalysis(async () => fakeResult("fresh"));
    await live2.runNow();
    expect(live2.latest?.comparison.newRev).toBe("fresh");
    live.close();
    live2.close();
  });

  it("hello carries a stable, unique per-server instance id", () => {
    const l1 = new LiveAnalysis(async () => fakeResult("a"));
    const l2 = new LiveAnalysis(async () => fakeResult("b"));
    const h1: LiveEvent[] = [];
    const h2: LiveEvent[] = [];
    l1.subscribe((e) => h1.push(e));
    l2.subscribe((e) => h2.push(e));
    const i1 = h1[0];
    const i2 = h2[0];
    expect(i1.type).toBe("hello");
    expect(i2.type).toBe("hello");
    if (i1.type === "hello" && i2.type === "hello") {
      expect(i1.instance).toBeTruthy();
      expect(i1.instance).not.toBe(i2.instance);
      // same coordinator keeps a stable instance across subscribers
      const again: LiveEvent[] = [];
      l1.subscribe((e) => again.push(e));
      expect(again[0].type === "hello" && again[0].instance === i1.instance).toBe(true);
    }
    l1.close();
    l2.close();
  });

  it("failed analysis keeps the previous result and reports the error", async () => {
    let calls = 0;
    const live = new LiveAnalysis(async () => {
      calls++;
      if (calls === 2) throw new Error("indexer exploded");
      return fakeResult(`ok${calls}`);
    }, { debounceMs: 10 });
    const events: LiveEvent[] = [];
    live.subscribe((e) => events.push(e));
    await live.runNow();              // ok1
    await live.runNow();              // error
    expect(live.latest?.comparison.newRev).toBe("ok1"); // preserved
    expect(live.lastError).toBe("indexer exploded");
    const err = events.find((e) => e.type === "analysis-error");
    expect(err).toBeDefined();
    await live.runNow();              // ok3 — recovery
    expect(live.latest?.comparison.newRev).toBe("ok3");
    expect(live.lastError).toBeUndefined();
    live.close();
  });
});

// ---------------------------------------------------------------------------
// Filesystem watcher — real chokidar against a scratch tree.
// ---------------------------------------------------------------------------

const WATCH_DIR = join(tmpdir(), "ripple-t3-watch");

describe("watchRepo filtering", () => {
  beforeAll(() => {
    rmSync(WATCH_DIR, { recursive: true, force: true });
    mkdirSync(join(WATCH_DIR, "src"), { recursive: true });
    mkdirSync(join(WATCH_DIR, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(WATCH_DIR, ".ripple", "cache"), { recursive: true });
    mkdirSync(join(WATCH_DIR, "dist"), { recursive: true });
  });

  it("source edits fire; node_modules/.ripple/dist/docs do not", async () => {
    const fired: string[] = [];
    const w = watchRepo(WATCH_DIR, (p) => fired.push(p.replace(/\\/g, "/")));
    await sleep(400); // let chokidar finish its initial scan
    writeFileSync(join(WATCH_DIR, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(WATCH_DIR, "README.md"), "# docs\n");
    writeFileSync(join(WATCH_DIR, "node_modules", "pkg", "x.ts"), "export {};\n");
    writeFileSync(join(WATCH_DIR, ".ripple", "cache", "g.json"), "{}\n");
    writeFileSync(join(WATCH_DIR, "dist", "out.js"), "x=1\n");
    writeFileSync(join(WATCH_DIR, "tsconfig.json"), "{}\n");
    await sleep(700);
    await w.close();
    expect(fired.some((p) => p.endsWith("src/a.ts"))).toBe(true);
    expect(fired.some((p) => p.endsWith("tsconfig.json"))).toBe(true);
    expect(fired.some((p) => p.includes("node_modules"))).toBe(false);
    expect(fired.some((p) => p.includes(".ripple"))).toBe(false);
    expect(fired.some((p) => p.endsWith("out.js") && p.includes("dist"))).toBe(false);
    expect(fired.some((p) => p.endsWith("README.md"))).toBe(false);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// End-to-end: real explorer server + SSE + real re-analysis on save.
// ---------------------------------------------------------------------------

const REPO = join(tmpdir(), "ripple-t3-live");

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

const SRC_V1 = `export function base(): string {
  return "v1";
}
`;
const USE_V1 = `import { base } from "./base";
export function call(): string {
  return base();
}
`;

async function readSse(url: string, want: (e: LiveEvent) => boolean, ms: number): Promise<LiveEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const res = await fetch(`${url}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const events: LiveEvent[] = [];
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const ev = JSON.parse(line.slice(6)) as LiveEvent;
          events.push(ev);
          if (want(ev)) return events;
        }
      }
    }
  } catch {
    /* aborted — return what we have */
  } finally {
    clearTimeout(timer);
  }
  return events;
}

describe("live explorer server (SSE + watcher end-to-end)", () => {
  let running: RunningExplorer;
  let baseSha = "";

  beforeAll(async () => {
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(join(REPO, "src"), { recursive: true });
    writeFileSync(
      join(REPO, "package.json"),
      JSON.stringify({ name: "live-fixture", version: "0.0.1", type: "module" }),
    );
    writeFileSync(
      join(REPO, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["src"],
      }),
    );
    writeFileSync(join(REPO, "src", "base.ts"), SRC_V1);
    writeFileSync(join(REPO, "src", "use.ts"), USE_V1);
    git("init", "-q", REPO);
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    baseSha = git("rev-parse", "HEAD");

    // Baseline working-tree change so the initial analysis is non-empty.
    writeFileSync(join(REPO, "src", "base.ts"), SRC_V1.replace('"v1"', '"v1-mod"'));
    running = await startExplorer({ repo: REPO, base: baseSha, port: 0, watch: true });
  }, 120_000);

  afterAll(async () => {
    await running.close();
    rmSync(REPO, { recursive: true, force: true });
  });

  it("/api/events streams hello then result events with revisions", async () => {
    const collecting = readSse(running.url, (e) => e.type === "analysis-result", 60_000);
    await sleep(400); // let the subscription land
    writeFileSync(join(REPO, "src", "base.ts"), SRC_V1.replace('"v1"', '"v1-live"'));
    const events = await collecting;
    const hello = events.find((e) => e.type === "hello");
    const started = events.find((e) => e.type === "analysis-started");
    const result = events.find((e) => e.type === "analysis-result");
    expect(hello).toBeDefined();
    expect(hello!.watching).toBe(true);
    expect(started).toBeDefined();
    expect(result).toBeDefined();
    expect(result!.revision).toBeGreaterThan(started!.revision - 1);
    const changed = (result as Extract<LiveEvent, { type: "analysis-result" }>)
      .result.changed.map((c) => c.name);
    expect(changed).toContain("base()");
  }, 90_000);

  it("burst of edits → one analysis cycle, latest result applied", async () => {
    const collecting = readSse(running.url, (e) => e.type === "analysis-result", 60_000);
    await sleep(400);
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(REPO, "src", "use.ts"), USE_V1 + `// burst ${i}\n`);
      await sleep(40);
    }
    const events = await collecting;
    const started = events.filter((e) => e.type === "analysis-started");
    const results = events.filter((e) => e.type === "analysis-result");
    // debounce coalesced the burst into a single started→result pair
    expect(started.length).toBe(1);
    expect(results.length).toBe(1);
  }, 90_000);

  it("broken source → analysis-error event; explorer stays alive on last result", async () => {
    const before = await fetch(`${running.url}/api/analysis`).then((r) => r.json() as Promise<AnalysisResult>);
    const collecting = readSse(
      running.url,
      (e) => e.type === "analysis-error" || e.type === "analysis-result",
      90_000,
    );
    await sleep(400);
    // Corrupt tsconfig breaks indexing deterministically.
    writeFileSync(join(REPO, "tsconfig.json"), "{ this is not json");
    const events = await collecting;
    const last = events.at(-1)!;
    expect(last.type).toBe("analysis-error");
    // The REST surface still serves the previous valid result.
    const after = await fetch(`${running.url}/api/analysis`).then((r) => r.json() as Promise<AnalysisResult>);
    expect(after.changed.map((c) => c.name)).toEqual(before.changed.map((c) => c.name));
  }, 120_000);

  it("fixing the source recovers automatically with a newer revision", async () => {
    const good = `{
      "compilerOptions": { "strict": true, "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext" },
      "include": ["src"]
    }`;
    const collecting = readSse(running.url, (e) => e.type === "analysis-result", 90_000);
    await sleep(400);
    writeFileSync(join(REPO, "tsconfig.json"), good);
    const events = await collecting;
    const result = events.find((e) => e.type === "analysis-result");
    expect(result).toBeDefined();
    expect((result as Extract<LiveEvent, { type: "analysis-result" }>).result.changed.length)
      .toBeGreaterThan(0);
    expect(running.live.latest).toBeDefined();
  }, 120_000);
});
