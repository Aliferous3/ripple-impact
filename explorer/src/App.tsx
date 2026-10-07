import { useEffect, useRef, useState } from "react";
import type { AnalysisResult } from "./types";
import { fetchAnalysis, subscribeEvents } from "./api";
import { Cascade } from "./cascade/Cascade";

export function App() {
  const [analysis, setAnalysis] = useState<AnalysisResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [analyzing, setAnalyzing] = useState(false);
  const [liveError, setLiveError] = useState<string | undefined>();
  /** Bumped per authoritative result — replays the unfold animation. */
  const [runId, setRunId] = useState(0);
  /** Newest applied analysis generation — stale completions never overwrite. */
  const appliedRev = useRef(0);
  /** Server process identity from the last hello — detects restarts. */
  const serverInstance = useRef<string | undefined>();
  const [reduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );

  useEffect(() => {
    fetchAnalysis()
      .then((r) => {
        setAnalysis(r);
        setRunId(1);
      })
      .catch((e) => setError(String(e)));
    return subscribeEvents({
      onHello: (h) => {
        // Latest-revision failure carried in hello — a client that missed
        // the analysis-error event still flags its data as stale.
        setLiveError(h.error);
        if (serverInstance.current === undefined) {
          // First connect — the initial fetchAnalysis above already covers it.
          serverInstance.current = h.instance;
          return;
        }
        const restarted = serverInstance.current !== h.instance;
        const missed = h.revision > appliedRev.current;
        serverInstance.current = h.instance;
        if (!restarted && !missed) return; // nothing to resync
        // Reconnect after restart or a missed generation — refetch the
        // authoritative snapshot so stale state can't persist.
        fetchAnalysis()
          .then((r) => {
            appliedRev.current = h.revision;
            setAnalysis(r);
            setRunId((n) => n + 1);
            setAnalyzing(h.running);
          })
          .catch(() => {});
      },
      onStarted: (rev) => {
        if (rev >= appliedRev.current) setAnalyzing(true);
      },
      onResult: (rev, result) => {
        if (rev < appliedRev.current) return; // stale generation — drop it
        appliedRev.current = rev;
        setAnalysis(result);
        setRunId((n) => n + 1);
        setAnalyzing(false);
        setLiveError(undefined);
      },
      onError: (rev, message) => {
        if (rev < appliedRev.current) return;
        // Keep the previous valid analysis on screen; just flag the failure.
        setAnalyzing(false);
        setLiveError(message);
      },
    });
  }, []);

  if (error) return <div className="app"><div className="empty-hint">{error}</div></div>;
  if (!analysis) {
    return <div className="app"><div className="empty-hint">Analyzing repository…</div></div>;
  }

  return (
    <Cascade
      analysis={analysis}
      analyzing={analyzing}
      liveError={liveError}
      runId={runId}
      reduced={reduced}
    />
  );
}
