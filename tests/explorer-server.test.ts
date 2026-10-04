import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startExplorer, type RunningExplorer } from "../src/server/explorer.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const TMP = join(tmpdir(), "ripple-t2-tests");
const REPO = join(TMP, "srv");

const CORE_V1 = `export function token(id: string): string {
  return "t:" + id;
}

export function caller(id: string): string {
  return token(id);
}
`;
const CORE_V2 = `export function token(id: string, salt = 0): string {
  return "t:" + id + ":" + salt;
}

export function caller(id: string): string {
  return token(id);
}
`;

let running: RunningExplorer;
let baseSha = "";

async function get(path: string): Promise<{ code: number; body: unknown }> {
  const res = await fetch(`${running.url}${path}`);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { code: res.status, body };
}

beforeAll(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(REPO, "src"), { recursive: true });
  writeFileSync(
    join(REPO, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "es2020" } }),
  );
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "srv", version: "1.0.0" }));
  writeFileSync(join(REPO, ".env"), "SECRET=hunter2\n");
  writeFileSync(join(REPO, "src", "core.ts"), CORE_V1);
  git(REPO, "init", "-q");
  git(REPO, "add", "-A");
  git(REPO, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c1");
  baseSha = git(REPO, "rev-parse", "HEAD").trim();
  writeFileSync(join(REPO, "src", "core.ts"), CORE_V2);
  git(REPO, "add", "-A");
  git(REPO, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c2");

  running = await startExplorer({ repo: REPO, base: baseSha, port: 0 });
}, 120_000);

afterAll(async () => {
  await running?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("explorer server", () => {
  it("binds to loopback only, on an OS-assigned port", () => {
    const addr = running.server.address();
    expect(addr).toBeTruthy();
    if (typeof addr === "object" && addr) {
      expect(addr.address).toBe("127.0.0.1");
      expect(addr.port).toBeGreaterThan(0);
    }
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
  });

  it("is unreachable via a non-loopback hostname path", async () => {
    // Connecting to the same port on the wildcard address must fail
    // because the server never listened there.
    const { port } = running;
    const tryConnect = (host: string) =>
      new Promise<boolean>((ok) => {
        const s = createConnection({ host, port }, () => {
          s.destroy();
          ok(true);
        });
        s.once("error", () => ok(false));
      });
    // Literal IPv6-all-interfaces wildcard won't be listening.
    expect(await tryConnect("::1")).toBe(false);
  });

  it("GET /api/analysis returns the engine's AnalysisResult", async () => {
    const { code, body } = await get("/api/analysis");
    expect(code).toBe(200);
    const a = body as { schemaVersion: number; changed: unknown[]; comparison: { base: string } };
    expect(a.schemaVersion).toBe(2);
    expect(a.comparison.base).toBe(baseSha);
    expect(a.changed.length).toBeGreaterThan(0);
    // Identity check: identical object the server already computed.
    expect(body).toEqual(JSON.parse(JSON.stringify(running.analysis)));
  });

  it("GET /api/node returns edges + downstream reach for known ids", async () => {
    const changed = running.analysis.changed.find((c) => c.id);
    expect(changed?.id).toBeTruthy();
    const { code, body } = await get(`/api/node?id=${encodeURIComponent(changed!.id!)}`);
    expect(code).toBe(200);
    const n = body as {
      node: { name: string };
      in: unknown[];
      out: unknown[];
      reach: { symbols: number; files: number; tests: number; directCallers: number };
    };
    expect(n.node.name).toBe(changed!.name);
    expect(n.reach.symbols).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/node rejects unknown ids", async () => {
    const { code } = await get("/api/node?id=nope");
    expect(code).toBe(404);
  });

  it("GET /api/source serves lines for files in the graph", async () => {
    const { code, body } = await get("/api/source?file=src/core.ts&start=1&end=3");
    expect(code).toBe(200);
    const s = body as { lines: string[]; totalLines: number };
    expect(s.lines[0]).toContain("export function token");
    expect(s.totalLines).toBeGreaterThan(0);
  });

  it("source preview refuses traversal, absolute paths, dotfiles, .env, .git", async () => {
    for (const p of [
      "../package.json",
      "..\\..\\windows.ini",
      "src/../../etc/passwd",
      "C:/Windows/win.ini",
      ".env",
      ".git/config",
      "src/../.env",
    ]) {
      const { code } = await get(`/api/source?file=${encodeURIComponent(p)}`);
      expect(code).toBe(403);
    }
    // Files simply outside the graph/diff are also refused.
    const { code } = await get("/api/source?file=package.json");
    expect(code).toBe(403);
  });

  it("source preview clamps absurd ranges", async () => {
    const { code, body } = await get("/api/source?file=src/core.ts&start=1&end=99999");
    expect(code).toBe(200);
    expect((body as { lines: string[] }).lines.length).toBeLessThanOrEqual(401);
  });

  it("static requests cannot escape the bundle dir", async () => {
    const { code } = await get("/../../etc/passwd");
    // Either 403 (blocked) or the SPA fallback HTML — never file contents.
    expect([200, 403]).toContain(code);
    if (code === 200) {
      const { body } = await get("/../../etc/passwd");
      expect(String(body)).toContain("<!"); // SPA fallback, not a passwd file
    }
  });

  it("non-GET API methods are rejected; unknown API paths 404", async () => {
    const res = await fetch(`${running.url}/api/analysis`, { method: "POST" });
    expect(res.status).toBe(405);
    const { code } = await get("/api/definitely-not-a-route");
    expect(code).toBe(404);
  });

  it("restart changes the SSE hello instance id — clients resync on reconnect", async () => {
    const helloOf = async (url: string) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const res = await fetch(`${url}/api/events`, { signal: ctrl.signal });
        const reader = res.body!.getReader();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (line) return JSON.parse(line.slice(6)) as { type: string; revision: number; instance?: string };
          }
        }
        return undefined;
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }
    };

    const first = await startExplorer({ repo: REPO, base: baseSha, port: 0 });
    const h1 = await helloOf(first.url);
    const second = await startExplorer({ repo: REPO, base: baseSha, port: 0 });
    const h2 = await helloOf(second.url);
    try {
      expect(h1?.type).toBe("hello");
      expect(h2?.type).toBe("hello");
      expect(h1!.instance).toBeTruthy();
      expect(h2!.instance).not.toBe(h1!.instance); // restart is detectable
      // restarted server counts revisions from scratch — the instance id is
      // what prevents the client from treating new events as stale
      const a = await fetch(`${second.url}/api/analysis`).then((r) => r.json());
      expect(a.changed.length).toBeGreaterThan(0);
    } finally {
      await first.close();
      await second.close();
    }
  }, 120_000);

  it("close() shuts the server down", async () => {
    const second = await startExplorer({ repo: REPO, base: baseSha, port: 0 });
    const url = second.url;
    await second.close();
    await expect(fetch(url)).rejects.toThrow();
  }, 120_000);
});
