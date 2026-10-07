import type { AnalysisResult, SourcePreview } from "./types";

export async function fetchAnalysis(): Promise<AnalysisResult> {
  const r = await fetch("/api/analysis");
  if (!r.ok) throw new Error(`analysis failed: ${r.status}`);
  return r.json();
}

export interface LiveEventHandlers {
  onStarted?: (revision: number) => void;
  onResult?: (revision: number, result: AnalysisResult) => void;
  onError?: (revision: number, message: string) => void;
  /**
   * Fired on every SSE (re)connect with the server's identity and latest
   * completed revision. A different `instance` than previously seen means
   * the server restarted and the client should resynchronize.
   */
  onHello?: (info: {
    revision: number;
    instance: string;
    running: boolean;
    error?: string;
  }) => void;
}

/**
 * Subscribe to server-sent analysis events. The channel is one-way
 * (server → browser); revisions are monotonically increasing so callers
 * can drop stale completions. Returns a close function.
 */
export function subscribeEvents(handlers: LiveEventHandlers): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data) as {
        type: string;
        revision: number;
        result?: AnalysisResult;
        message?: string;
        instance?: string;
        running?: boolean;
        error?: string;
      };
      if (ev.type === "hello")
        handlers.onHello?.({
          revision: ev.revision,
          instance: ev.instance ?? "",
          running: ev.running ?? false,
          error: ev.error,
        });
      else if (ev.type === "analysis-started") handlers.onStarted?.(ev.revision);
      else if (ev.type === "analysis-result" && ev.result)
        handlers.onResult?.(ev.revision, ev.result);
      else if (ev.type === "analysis-error") handlers.onError?.(ev.revision, ev.message ?? "analysis failed");
    } catch {
      /* malformed event — ignore */
    }
  };
  return () => es.close();
}

export async function fetchSource(
  file: string,
  start: number,
  end: number,
): Promise<SourcePreview | undefined> {
  const r = await fetch(
    `/api/source?file=${encodeURIComponent(file)}&start=${start}&end=${end}`,
  );
  if (!r.ok) return undefined;
  return r.json();
}
