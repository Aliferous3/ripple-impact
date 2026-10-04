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
