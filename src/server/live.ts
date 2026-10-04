import { randomUUID } from "node:crypto";
import type { AnalysisResult } from "../api/analyze.js";

/**
 * Live analysis coordinator — the engine-side of watch mode.
 *
 * Runs are serialized: at most one analysis is in flight. A change arriving
 * mid-run marks the result dirty and re-runs once the current run settles.
 * Every run carries a monotonically increasing revision; a result is only
 * adopted as `latest` when its revision is still the newest accepted
 * generation, so a stale completion can never overwrite a newer one.
 *
 * Failures never clear `latest` — subscribers get an `analysis-error` and
 * consumers keep showing the previous valid result.
 */

export type LiveEvent =
  | {
      type: "hello";
      revision: number;
      watching: boolean;
      running: boolean;
      /**
       * Per-process id — a server restart produces a new instance, so a
       * reconnecting client can detect it even when the revision counter
       * coincidentally matches its last applied revision.
       */
      instance: string;
    }
  | { type: "analysis-started"; revision: number }
  | { type: "analysis-result"; revision: number; result: AnalysisResult }
  | { type: "analysis-error"; revision: number; message: string };

type Listener = (ev: LiveEvent) => void;

export class LiveAnalysis {
  revision = 0;
  running = false;
  latest: AnalysisResult | undefined;
  lastError: string | undefined;
  /** Whether a filesystem watcher is feeding requests (reported in hello). */
  watching = false;
  /** Unique per coordinator — identifies this server process to clients. */
  readonly instance = randomUUID();

  private readonly compute: () => Promise<AnalysisResult>;
  private readonly debounceMs: number;
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private closed = false;

  constructor(
    compute: () => Promise<AnalysisResult>,
    opts: { debounceMs?: number } = {},
  ) {
    this.compute = compute;
    this.debounceMs = opts.debounceMs ?? 300;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn({
      type: "hello",
      revision: this.revision,
      watching: this.watching,
      running: this.running,
      instance: this.instance,
    });
    return () => this.listeners.delete(fn);
  }

  /**
   * Request a re-analysis. Calls inside the debounce window coalesce into
   * one run — an editor save-burst produces a single analysis.
   */
  request(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.debounceMs);
  }

  /** Run immediately (tests, initial priming). */
  async runNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.run();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  private emit(ev: LiveEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    do {
      this.pending = false;
      const rev = ++this.revision;
      this.emit({ type: "analysis-started", revision: rev });
      try {
        const result = await this.compute();
        // Stale-completion guard: adopt only the newest generation.
        if (rev === this.revision) {
          this.latest = result;
          this.lastError = undefined;
        }
        this.emit({ type: "analysis-result", revision: rev, result });
      } catch (err) {
        // Previous `latest` stays put — the explorer keeps the old graph.
        const message = (err as Error).message ?? String(err);
        if (rev === this.revision) this.lastError = message;
        this.emit({ type: "analysis-error", revision: rev, message });
      }
    } while (this.pending && !this.closed);
    this.running = false;
  }
}
