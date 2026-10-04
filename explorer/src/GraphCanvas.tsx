import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { ViewModel, VMNode } from "./viewmodel";

const NODE_W = 220;
const NODE_H = 44;
const REVEAL_STEP_MS = 160;

const CATEGORY_TAG: Record<string, string> = {
  changed: "CHG",
  deleted: "DEL",
  direct: "D1",
  transitive: "D+",
  test: "TEST",
  referencing: "REF",
};

type RFNode = Node<{ vm: VMNode; selected: boolean; dim: boolean; delay: number }, "rnode">;

function RNode({ data }: NodeProps<RFNode>) {
  const { vm } = data;
  return (
    <div
      className={`rnode ${vm.category} ${data.selected ? "selected" : ""} ${data.dim ? "dim" : ""} reveal`}
      style={{ animationDelay: `${data.delay}ms` }}
      title={`${vm.file} — ${vm.label}`}
    >
      <span className="tag">{vm.changeKind?.toUpperCase().slice(0, 3) ?? CATEGORY_TAG[vm.category] ?? "?"}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {vm.label}
      </span>
    </div>
  );
}

const nodeTypes = { rnode: RNode };

function layout(nodes: VMNode[], edges: ViewModel["edges"]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 56, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) pos.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }
  return pos;
}

export interface CanvasProps {
  vm: ViewModel;
  visibleIds: Set<string>; // after filters + depth + guard
  focusRoot?: string;
  selectedId?: string;
  guarded: boolean;
  onSelect: (id: string | undefined) => void;
}

function CanvasInner({ vm, visibleIds, focusRoot, selectedId, guarded, onSelect }: CanvasProps) {
  const { fitView, setCenter, getNode, getViewport } = useReactFlow();
  const reducedMotion = useRef(
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const focusIds = useMemo(() => {
    if (!focusRoot) return undefined;
    const f = vm.focusSet.get(focusRoot);
    return f ? f.nodes : new Set([focusRoot]);
  }, [vm, focusRoot]);
  const focusEdgeIds = useMemo(() => vm.focusSet.get(focusRoot ?? "")?.edges, [vm, focusRoot]);

  const { rfNodes, rfEdges } = useMemo(() => {
    const nodes = vm.nodes.filter((n) => visibleIds.has(n.id));
    const edges = vm.edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
    );
    const pos = layout(nodes, edges);
    const rfNodes: RFNode[] = nodes.map((n) => ({
      id: n.id,
      type: "rnode",
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: {
        vm: n,
        selected: n.id === selectedId,
        dim: focusIds !== undefined && !focusIds.has(n.id),
        delay: reducedMotion.current ? 0 : Math.min(n.depth, 8) * REVEAL_STEP_MS,
      },
    }));
    const rfEdges: Edge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: false,
      style: {
        stroke: e.weak ? "#565d68" : "#6ea8d8",
        strokeWidth: e.weak ? 1 : 1.4,
        strokeDasharray: e.weak ? "5 4" : undefined,
        opacity: focusIds === undefined || focusEdgeIds?.has(e.id) ? 0.9 : 0.08,
      },
    }));
    return { rfNodes, rfEdges };
  }, [vm, visibleIds, focusIds, focusEdgeIds, selectedId]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => onSelect(node.id === selectedId ? undefined : node.id),
    [onSelect, selectedId],
  );

  // Center + select when the deep link / search picks a node.
  const centerOn = useCallback(
    (id: string) => {
      const n = getNode(id);
      if (n) setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom: 1.15, duration: 250 });
    },
    [getNode, setCenter],
  );
  useEffect(() => {
    if (selectedId) centerOn(selectedId);
  }, [selectedId, centerOn]);

  useEffect(() => {
    const t = setTimeout(() => {
      void fitView({ padding: 0.15, duration: 300 }).then(() => {
        // Large surfaces fit to an illegible zoom — instead center on the
        // changed roots at reading size; pan/minimap cover the rest.
        const vp = getViewport();
        if (vp.zoom < 0.4) {
          const roots = rfNodes.filter(
            (n) => n.data.vm.category === "changed" || n.data.vm.category === "deleted",
          );
          const pts = roots.length ? roots : rfNodes;
          if (pts.length === 0) return;
          const cx = pts.reduce((s, n) => s + n.position.x + NODE_W / 2, 0) / pts.length;
          const cy = pts.reduce((s, n) => s + n.position.y + NODE_H / 2, 0) / pts.length;
          void setCenter(cx, cy, { zoom: 0.85, duration: 300 });
        }
      });
    }, 80);
    return () => clearTimeout(t);
  }, [fitView, getViewport, setCenter, rfNodes]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const inInput = (ev.target as HTMLElement)?.tagName === "INPUT";
      if (ev.key === "Escape") {
        if (inInput) (ev.target as HTMLElement).blur();
        onSelect(undefined);
        return;
      }
      if (inInput) return;
      if (ev.key === "f" || ev.key === "F") void fitView({ padding: 0.15, duration: 250 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitView, onSelect]);

  return (
    <>
      {guarded && (
        <div className="guard-banner" data-testid="guard-banner">
          Large impact surface — showing changed + direct + nearest downstream.
          Narrow depth or filters to expand.
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => onSelect(undefined)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.05}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#22262d" gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor="#2a2f37" maskColor="rgba(15,17,20,0.75)" />
      </ReactFlow>
    </>
  );
}

export function GraphCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
