import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult } from "./types";
import type { Category, ViewModel, VMNode } from "./viewmodel";

export const CATEGORY_META: { key: Category; label: string; color: string }[] = [
  { key: "changed", label: "Changed", color: "var(--c-changed)" },
  { key: "deleted", label: "Deleted", color: "var(--c-deleted)" },
  { key: "direct", label: "Directly affected", color: "var(--c-direct)" },
  { key: "transitive", label: "Transitively affected", color: "var(--c-transitive)" },
  { key: "test", label: "Tests", color: "var(--c-test)" },
  { key: "referencing", label: "Referencing", color: "var(--c-referencing)" },
];

export interface SidebarProps {
  analysis: AnalysisResult;
  vm: ViewModel;
  visible: Set<Category>;
  onToggleCategory: (c: Category) => void;
  maxDepth: number;
  onDepth: (d: number) => void;
  onSelect: (id: string | undefined) => void;
  onFocusTest: (file: string) => void;
}

export function Sidebar({
  analysis,
  vm,
  visible,
  onToggleCategory,
  maxDepth,
  onDepth,
  onSelect,
  onFocusTest,
}: SidebarProps) {
  const [q, setQ] = useState("");
  const [showResults, setShowResults] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "/" && (ev.target as HTMLElement)?.tagName !== "INPUT") {
        ev.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo<VMNode[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return vm.nodes
      .filter((n) => n.label.toLowerCase().includes(needle) || n.file.toLowerCase().includes(needle))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 25);
  }, [q, vm]);

  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const n of vm.nodes) m.set(n.category, (m.get(n.category) ?? 0) + 1);
    return m;
  }, [vm]);

  return (
    <div className="sidebar">
      <h3>Search</h3>
      <div className="search-box">
        <input
          ref={inputRef}
          data-testid="search-input"
          placeholder="/ symbol or file…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShowResults(true);
          }}
          onFocus={() => setShowResults(true)}
          onBlur={() => setTimeout(() => setShowResults(false), 150)}
        />
        {showResults && results.length > 0 && (
          <div className="search-results" data-testid="search-results">
            {results.map((r) => (
              <div
                key={r.id}
                className="sr"
                onMouseDown={() => {
                  onSelect(r.id);
                  setShowResults(false);
                }}
              >
                <div className="mono">{r.label}</div>
                <div className="f">{r.file}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <h3>Impact depth</h3>
      <div className="depth-ctl">
        <select
          data-testid="depth-select"
          value={maxDepth === Infinity ? "all" : String(maxDepth)}
          onChange={(e) => onDepth(e.target.value === "all" ? Infinity : Number(e.target.value))}
        >
          <option value="1">Direct only</option>
          <option value="2">Depth ≤ 2</option>
          <option value="3">Depth ≤ 3</option>
          <option value="all">All downstream</option>
        </select>
      </div>

      <h3>Filters</h3>
      {CATEGORY_META.map((c) => (
        <label key={c.key} className="filter-row" data-testid={`filter-${c.key}`}>
          <input
            type="checkbox"
            checked={visible.has(c.key)}
            onChange={() => onToggleCategory(c.key)}
          />
          <span className="filter-swatch" style={{ background: c.color }} />
          <span>{c.label}</span>
          <span style={{ marginLeft: "auto", color: "var(--faint)" }}>
            {counts.get(c.key) ?? 0}
          </span>
        </label>
      ))}

      <h3>Relevant tests</h3>
      {analysis.tests.length === 0 && <div className="sub" style={{ color: "var(--faint)" }}>none</div>}
      {analysis.tests.map((t) => (
        <div
          key={t.file}
          className="list-item"
          data-testid="test-item"
          onClick={() => onFocusTest(t.file)}
        >
          <span style={{ color: "var(--c-test)" }}>✓</span>
          <span className="mono">{t.file}</span>
        </div>
      ))}

      <h3>Warnings</h3>
      {analysis.warnings.length === 0 && (
        <div className="sub" style={{ color: "var(--faint)" }}>no analysis limitations</div>
      )}
      {analysis.warnings.map((w, i) => (
        <div key={i} className="list-item warn-item" data-testid="warning-item" title={w.message}>
          <span className="code">{w.code}</span>
          <span className="sub">{w.file ?? w.symbol ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

