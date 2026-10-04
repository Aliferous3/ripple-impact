import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepository, analyzeSymbol, type AnalysisResult } from "../api/analyze.js";
import { getGraphForRepo } from "../cache/graph.js";
import { repoFingerprint } from "../cache/fingerprint.js";
import { impactNodes } from "../impact/traverse.js";
import type { RippleGraph } from "../graph/graph.js";
import { LiveAnalysis } from "./live.js";
import { watchRepo } from "./watch.js";

/**
 * Loopback-only explorer server. Serves the prebuilt React bundle plus a
 * minimal read-only API over the engine's AnalysisResult.
 *
 * Security contract:
 *  - binds to 127.0.0.1 only (never 0.0.0.0)
 *  - /api/source resolves strictly under the repo root, rejects "..",
 *    absolute paths, .git/, and dotenv-style files, and only serves files
 *    that appear in the graph or the diff (nothing arbitrary)
 *  - no telemetry, no external requests, no writes
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const BLOCKED_PATH = /(^|[/\\])\.git([/\\]|$)|(^|[/\\])\.env|(^|[/\\])node_modules([/\\]|$)/i;
const MAX_PREVIEW_LINES = 400;

export interface ExplorerContext {
  repo: string;
  /** Latest good analysis — swapped in place on live updates, never nulled. */
  analysis: AnalysisResult;
  graph: RippleGraph;
}

export interface RunningExplorer {
  url: string;
  port: number;
  server: Server;
  analysis: AnalysisResult;
  live: LiveAnalysis;
  close: () => Promise<void>;
}

async function buildContext(
  repo: string,
  base: string | undefined,
  symbol: string | undefined,
): Promise<ExplorerContext> {
  const repoRoot = resolve(repo);
  let analysis: AnalysisResult;
  if (symbol) {
    const res = await analyzeSymbol({ repo: repoRoot, symbol });
    if (!res.ok) {
      const hint = res.candidates.length
        ? ` Candidates: ${res.candidates.map((c) => c.selector).join(", ")}`
        : "";
      throw new Error(`${res.error}.${hint}`);
    }
    analysis = res.result;
  } else {
    analysis = await analyzeRepository({ repo: repoRoot, base });
  }
  const { graph } = await getGraphForRepo(repoRoot); // cache hit after analysis
  return { repo: repoRoot, analysis, graph };
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(data);
}

function send(res: ServerResponse, code: number, body: string | Buffer, type = "text/plain"): void {
  res.writeHead(code, { "content-type": type });
  res.end(body);
}

/** Resolve `file` strictly under the repo root and gate on graph/diff membership. */
function safeRepoFile(ctx: ExplorerContext, file: string): string | undefined {
  if (!file || isAbsolute(file) || file.includes("..") || file.includes("\0")) return undefined;
  const rel = normalize(file).split(sep).join("/");
  if (BLOCKED_PATH.test(rel)) return undefined;
  const inGraph = ctx.graph.nodes.some((n) => n.file === rel);
  const inDiff = ctx.analysis.diffFiles.some((f) => f.path === rel || f.oldPath === rel);
  if (!inGraph && !inDiff) return undefined;
  const abs = resolve(ctx.repo, rel);
  if (abs !== ctx.repo && !abs.startsWith(ctx.repo + sep)) return undefined;
  if (!existsSync(abs)) return undefined;
  return abs;
}

function handleApi(
  ctx: ExplorerContext,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  live: LiveAnalysis,
): boolean {
  const { pathname } = url;

  // Server-sent events: one-way server → browser channel carrying
  // analysis lifecycle (started / result / error) with revisions.
  if (pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const send = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const unsubscribe = live.subscribe(send);
    req.on("close", unsubscribe);
    return true;
  }

  if (pathname === "/api/analysis") {
    sendJson(res, 200, ctx.analysis);
    return true;
  }

  if (pathname === "/api/node") {
    const id = url.searchParams.get("id") ?? "";
    const node = ctx.graph.node(id);
    if (!node) {
      sendJson(res, 404, { error: "unknown node id" });
      return true;
    }
    const name = (nid: string) => ctx.graph.node(nid)?.name ?? nid;
    // Downstream reach = everything that would be affected if this node
    // changed — reuse the engine traversal, not a reimplementation.
    const reach = impactNodes(ctx.graph, [node]);
    const reachNodes = [...reach.direct, ...reach.transitive].map((a) => a.node);
    sendJson(res, 200, {
      node,
      out: ctx.graph.outEdges(id).map((e) => ({ ...e, toName: name(e.to) })),
      in: ctx.graph.inEdges(id).map((e) => ({ ...e, fromName: name(e.from) })),
      reach: {
        symbols: reachNodes.length,
        files: new Set(reachNodes.map((n) => n.file)).size,
        tests: reach.relevantTests.length,
        directCallers: ctx.graph.inEdges(id, ["calls", "jsx_uses"]).length,
      },
    });
    return true;
  }

  if (pathname === "/api/source") {
    const file = url.searchParams.get("file") ?? "";
    const abs = safeRepoFile(ctx, file);
    if (!abs) {
      sendJson(res, 403, { error: "path not allowed" });
      return true;
    }
    const start = Math.max(1, Number(url.searchParams.get("start") ?? 1) | 0);
    const end = Math.min(start + MAX_PREVIEW_LINES, Number(url.searchParams.get("end") ?? start) | 0);
    try {
      const lines = readFileSync(abs, "utf8").split("\n");
      sendJson(res, 200, {
        file: file.split("\\").join("/"),
        start,
        end: Math.min(end, lines.length),
        totalLines: lines.length,
        lines: lines.slice(start - 1, end),
      });
    } catch {
      sendJson(res, 500, { error: "unreadable" });
    }
    return true;
  }

  return false;
}

export async function startExplorer(opts: {
  repo: string;
  base?: string;
  symbol?: string;
  port?: number;
  staticDir?: string;
  /** Watch the working tree and push re-analyses over SSE (default: on). */
  watch?: boolean;
}): Promise<RunningExplorer> {
  const ctx = await buildContext(opts.repo, opts.base, opts.symbol);
  const staticDir =
    opts.staticDir ??
    resolve(fileURLToPath(new URL("../../dist/explorer", import.meta.url)));

  // Live pipeline: every run rebuilds the context in place, so /api/*
  // endpoints always see the newest valid analysis + graph. A save that
  // leaves file contents unchanged (touch/no-op write) returns the last
  // result without paying for a cache-hit pipeline pass.
  let lastFingerprint = repoFingerprint(ctx.repo).key;
  let latestResult: AnalysisResult | undefined = ctx.analysis;
  const live = new LiveAnalysis(async (): Promise<AnalysisResult> => {
    const fp = repoFingerprint(ctx.repo).key;
    if (fp === lastFingerprint && latestResult) return latestResult;
    const fresh = await buildContext(opts.repo, opts.base, opts.symbol);
    lastFingerprint = fp;
    latestResult = fresh.analysis;
    ctx.analysis = fresh.analysis;
    ctx.graph = fresh.graph;
    return fresh.analysis;
  });
  live.latest = ctx.analysis;
  live.watching = opts.watch !== false;
  const watcher = live.watching
    ? watchRepo(ctx.repo, () => live.request())
    : undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") {
          send(res, 405, "method not allowed");
          return;
        }
        if (!handleApi(ctx, url, req, res, live)) sendJson(res, 404, { error: "not found" });
        return;
      }
      // Static bundle with SPA fallback.
      let path = normalize(url.pathname).replace(/^([/\\])+/, "");
      if (path === "" || path === "index.html") path = "index.html";
      if (path.includes("..") || isAbsolute(path) || BLOCKED_PATH.test(path)) {
        send(res, 403, "forbidden");
        return;
      }
      const abs = resolve(staticDir, path);
      if (!abs.startsWith(staticDir + sep) && abs !== staticDir) {
        send(res, 403, "forbidden");
        return;
      }
      if (existsSync(abs) && !abs.endsWith(sep)) {
        send(res, 200, readFileSync(abs), MIME[extname(abs)] ?? "application/octet-stream");
        return;
      }
      const index = join(staticDir, "index.html");
      if (existsSync(index)) {
        send(res, 200, readFileSync(index), "text/html; charset=utf-8");
        return;
      }
      send(res, 503, "explorer bundle not built — run: npx vite build --config vite.explorer.config.ts");
    } catch (err) {
      send(res, 500, `internal error: ${(err as Error).message}`);
    }
  });

  await new Promise<void>((ok, err) => {
    server.once("error", err);
    // Port 0 → OS picks a free port; binds loopback only.
    server.listen(opts.port ?? 0, "127.0.0.1", () => ok());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    analysis: ctx.analysis,
    live,
    close: async () => {
      // On Windows fs.watch teardown asserts if the tree disappears first —
      // always close the watcher before the caller may delete the repo.
      await watcher?.close();
      live.close();
      await new Promise<void>((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      });
    },
  };
}
