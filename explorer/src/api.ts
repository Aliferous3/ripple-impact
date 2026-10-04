import type { AnalysisResult, NodeDetail, SourcePreview } from "./types";

export async function fetchAnalysis(): Promise<AnalysisResult> {
  const r = await fetch("/api/analysis");
  if (!r.ok) throw new Error(`analysis failed: ${r.status}`);
  return r.json();
}

export async function fetchNode(id: string): Promise<NodeDetail> {
  const r = await fetch(`/api/node?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`node fetch failed: ${r.status}`);
  return r.json();
}

export interface LiveEventHandlers {
  onStarted?: (revision: number) => void;
  onResult?: (revision: number, result: AnalysisResult) => void;
  onError?: (revision: number, message: string) => void;
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
      };
      if (ev.type === "analysis-started") handlers.onStarted?.(ev.revision);
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
