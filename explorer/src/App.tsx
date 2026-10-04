import { useEffect, useMemo, useState } from "react";
import type { AnalysisResult } from "./types";
import { buildViewModel, type Category } from "./viewmodel";
import { fetchAnalysis } from "./api";
import { GraphCanvas } from "./GraphCanvas";
import { Sidebar } from "./Sidebar";
import { DetailsPanel } from "./DetailsPanel";

/** Render cap — measured comfortably for React Flow + dagre at these sizes. */
const MAX_RENDERED_NODES = 250;

const ALL_CATEGORIES: Category[] = [
  "changed",
  "deleted",
  "direct",
  "transitive",
  "test",
  "referencing",
];

function readHash(): { n?: string; f?: string } {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  return { n: p.get("n") ?? undefined, f: p.get("f") ?? undefined };
}

export function App() {
  const [analysis, setAnalysis] = useState<AnalysisResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [visible, setVisible] = useState<Set<Category>>(new Set(ALL_CATEGORIES));
  const [maxDepth, setMaxDepth] = useState<number>(Infinity);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => readHash().n);
  const [focusRoot, setFocusRoot] = useState<string | undefined>(() => readHash().f);

  useEffect(() => {
    fetchAnalysis().then(setAnalysis).catch((e) => setError(String(e)));
  }, []);

  const vm = useMemo(() => (analysis ? buildViewModel(analysis) : undefined), [analysis]);

  // Visible set: category filters + depth cap, then the large-graph guard.
  const { visibleIds, guarded } = useMemo(() => {
    if (!vm) return { visibleIds: new Set<string>(), guarded: false };
    const base = vm.nodes.filter(
      (n) =>
        visible.has(n.category) &&
        (n.category === "transitive" || n.category === "direct"
          ? n.depth <= maxDepth
          : true),
    );
    if (base.length <= MAX_RENDERED_NODES) {
      return { visibleIds: new Set(base.map((n) => n.id)), guarded: false };
    }
    const rank = (n: (typeof base)[number]) =>
      n.category === "changed" || n.category === "deleted"
        ? 0
        : n.category === "direct"
          ? 1
          : n.category === "test"
            ? 2
            : n.category === "transitive"
              ? 3
              : 4;
    const kept = [...base]
      .sort((a, b) => rank(a) - rank(b) || a.depth - b.depth || a.label.localeCompare(b.label))
      .slice(0, MAX_RENDERED_NODES);
    return { visibleIds: new Set(kept.map((n) => n.id)), guarded: true };
  }, [vm, visible, maxDepth]);

  // Deep link: selection + focus encoded in the URL hash.
  useEffect(() => {
    const p = new URLSearchParams();
    if (selectedId) p.set("n", selectedId);
    if (focusRoot) p.set("f", focusRoot);
    const h = p.toString();
    history.replaceState(null, "", h ? `#${h}` : location.pathname);
  }, [selectedId, focusRoot]);

  if (error) return <div className="app"><div className="empty-hint">{error}</div></div>;
  if (!analysis || !vm) {
    return <div className="app"><div className="empty-hint">Analyzing repository…</div></div>;
  }

  const selected = selectedId ? vm.byId.get(selectedId) : undefined;
  const cmp = analysis.comparison;
  const title = `${cmp.oldRev.slice(0, 10)} → ${cmp.newRev}`;

  const toggle = (c: Category) =>
    setVisible((s) => {
      const n = new Set(s);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });

  const focusTestFile = (file: string) => {
    const t = vm.nodes.find((n) => n.category === "test" && n.file === file);
    if (t) setSelectedId(t.id);
  };

  return (
    <div className="app">
      <div className="header">
        <span className="brand">RIPPLE</span>
        <span className="comparison" data-testid="comparison">{title}</span>
        {focusRoot && (
          <button className="btn" data-testid="clear-focus" onClick={() => setFocusRoot(undefined)}>
            ← back to full impact
          </button>
        )}
        <div className="stats">
          <div className="stat"><b data-testid="count-changed">{analysis.changed.length}</b><span>changed</span></div>
          <div className="stat"><b data-testid="count-direct">{analysis.direct.length}</b><span>direct</span></div>
          <div className="stat"><b data-testid="count-transitive">{analysis.transitive.length}</b><span>downstream</span></div>
          <div className="stat"><b data-testid="count-tests">{analysis.tests.length}</b><span>tests</span></div>
          <div className="stat warn"><b data-testid="count-warnings">{analysis.warnings.length}</b><span>warnings</span></div>
        </div>
      </div>
      <div className="main">
        <Sidebar
          analysis={analysis}
          vm={vm}
          visible={visible}
          onToggleCategory={toggle}
          maxDepth={maxDepth}
          onDepth={setMaxDepth}
          onSelect={setSelectedId}
          onFocusTest={focusTestFile}
        />
        <div className="canvas">
          <GraphCanvas
            vm={vm}
            visibleIds={visibleIds}
            guarded={guarded}
            focusRoot={focusRoot}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
          />
        </div>
        <DetailsPanel
          node={selected}
          vm={vm}
          analysis={analysis}
          onFocus={(id) => setFocusRoot(id)}
          onSelect={setSelectedId}
        />
      </div>
    </div>
  );
}
