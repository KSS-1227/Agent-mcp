"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Filter,
  Search,
  X,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import clsx from "clsx";

export interface GraphNode {
  id: string;
  label: string;
  type: "agent" | "intent" | "resource" | "conflict";
  status?: string;
  metadata?: Record<string, any>;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  status?: "safe" | "threatened" | "invalidated";
}

interface ConflictGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelectNode?: (node: GraphNode | null) => void;
  selectedNodeId?: string | null;
  className?: string;
}

/**
 * Layout is a grid of fixed-height cards, one group per entity type. Groups are
 * only created for types that actually have nodes, so a graph without conflict
 * records does not reserve (and label) an empty adjudication column.
 */
const NODE_W = 180;
const NODE_H = 48;
const COL_W = 250;
const ROW_H = 110;
const ROWS_PER_COL = 12;
const FIRST_ROW_Y = 64;
const MIN_SCALE = 0.12;
const MAX_SCALE = 2.5;

const GROUPS: Array<{ type: GraphNode["type"]; title: string }> = [
  { type: "agent", title: "AGENTS" },
  { type: "intent", title: "DECLARED INTENTS" },
  { type: "conflict", title: "CONFLICT NODES" },
  { type: "resource", title: "VERSIONED RESOURCES" },
];

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

interface Viewport {
  scale: number;
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const ConflictGraph: React.FC<ConflictGraphProps> = ({
  nodes: initialNodes,
  edges: initialEdges,
  onSelectNode,
  selectedNodeId,
  className,
}) => {
  const [view, setView] = useState<Viewport>({ scale: 1, x: 40, y: 30 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ pointerX: number; pointerY: number; originX: number; originY: number } | null>(
    null
  );
  const [filterMode, setFilterMode] = useState<"all" | "conflicts_only">("all");
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totals = useMemo(() => {
    const counts = { agent: 0, intent: 0, resource: 0, conflict: 0 };
    initialNodes.forEach((n) => {
      counts[n.type] += 1;
    });
    return counts;
  }, [initialNodes]);

  const layout = useMemo(() => {
    const byType: Record<string, GraphNode[]> = { agent: [], intent: [], conflict: [], resource: [] };
    initialNodes.forEach((node) => {
      (byType[node.type] ?? byType.resource).push(node);
    });

    const positioned: PositionedNode[] = [];
    const headers: Array<{ x: number; y: number; title: string; count: number }> = [];
    let column = 0;

    for (const group of GROUPS) {
      const list = byType[group.type] ?? [];
      if (list.length === 0) continue;

      headers.push({
        x: column * COL_W + 4,
        y: 34,
        title: group.title,
        count: list.length,
      });

      list.forEach((node, index) => {
        const subColumn = Math.floor(index / ROWS_PER_COL);
        const row = index % ROWS_PER_COL;
        positioned.push({
          ...node,
          x: column * COL_W + subColumn * COL_W + NODE_W / 2,
          y: FIRST_ROW_Y + row * ROW_H,
        });
      });

      column += Math.ceil(list.length / ROWS_PER_COL);
    }

    const width = Math.max(column * COL_W, COL_W);
    const height = FIRST_ROW_Y + Math.min(ROWS_PER_COL, Math.max(positioned.length, 1)) * ROW_H;

    return { positioned, headers, width, height, columns: column };
  }, [initialNodes]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, PositionedNode>();
    layout.positioned.forEach((node) => map.set(node.id, node));
    return map;
  }, [layout.positioned]);

  /** Nodes the "Conflicts Only" view keeps: conflict records plus what they touch. */
  const conflictNodeIds = useMemo(() => {
    const ids = new Set<string>();
    layout.positioned.forEach((node) => {
      if (node.type === "conflict" || node.status === "threatened" || node.status === "invalidating") {
        ids.add(node.id);
      }
    });
    initialEdges.forEach((edge) => {
      if (ids.has(edge.source) || ids.has(edge.target)) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
    });
    return ids;
  }, [layout.positioned, initialEdges]);

  const normalizedQuery = query.trim().toLowerCase();

  const matchIds = useMemo(() => {
    if (!normalizedQuery) return null;
    const ids = new Set<string>();
    layout.positioned.forEach((node) => {
      const haystack = [node.label, node.status, node.metadata?.key, node.metadata?.type, node.id]
        .filter((part) => typeof part === "string")
        .join(" ")
        .toLowerCase();
      if (haystack.includes(normalizedQuery)) ids.add(node.id);
    });
    return ids;
  }, [layout.positioned, normalizedQuery]);

  /** Search keeps the matches and their direct neighbours so edges stay meaningful. */
  const focusIds = useMemo(() => {
    if (!matchIds) return null;
    const ids = new Set(matchIds);
    initialEdges.forEach((edge) => {
      if (matchIds.has(edge.source)) ids.add(edge.target);
      if (matchIds.has(edge.target)) ids.add(edge.source);
    });
    return ids;
  }, [matchIds, initialEdges]);

  const visibleNodes = useMemo(() => {
    let list = layout.positioned;
    if (filterMode === "conflicts_only") {
      list = list.filter((node) => conflictNodeIds.has(node.id));
    }
    if (focusIds) {
      list = list.filter((node) => focusIds.has(node.id));
    }
    return list;
  }, [layout.positioned, filterMode, conflictNodeIds, focusIds]);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleEdges = useMemo(
    () => initialEdges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
    [initialEdges, visibleNodeIds]
  );

  /** Edges whose endpoints are not in the payload could never be drawn — report them. */
  const unresolvedEdges = useMemo(
    () => initialEdges.filter((e) => !nodeMap.has(e.source) || !nodeMap.has(e.target)).length,
    [initialEdges, nodeMap]
  );

  const fitTo = useCallback(
    (list: PositionedNode[]) => {
      if (!size.width || !size.height || list.length === 0) return;
      const pad = 28;
      const minX = Math.min(...list.map((n) => n.x - NODE_W / 2)) - pad;
      const maxX = Math.max(...list.map((n) => n.x + NODE_W / 2)) + pad;
      const minY = Math.min(...list.map((n) => n.y)) - 44;
      const maxY = Math.max(...list.map((n) => n.y + NODE_H)) + pad;
      const width = Math.max(maxX - minX, 1);
      const height = Math.max(maxY - minY, 1);
      const scale = clamp(Math.min(size.width / width, size.height / height), MIN_SCALE, 1.1);
      const next: Viewport = {
        scale,
        x: (size.width - width * scale) / 2 - minX * scale,
        y: (size.height - height * scale) / 2 - minY * scale,
      };
      setView((prev) =>
        Math.abs(prev.scale - next.scale) < 0.001 &&
        Math.abs(prev.x - next.x) < 0.5 &&
        Math.abs(prev.y - next.y) < 0.5
          ? prev
          : next
      );
    },
    [size]
  );

  // Re-fit whenever the drawn set, the canvas size or the starting data changes.
  const fitSignature = [
    visibleNodes.length,
    normalizedQuery,
    filterMode,
    initialNodes.length,
    Math.round(size.width),
    Math.round(size.height),
  ].join("|");

  useEffect(() => {
    fitTo(visibleNodes);
    // `visibleNodes` is fully described by `fitSignature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignature]);

  const zoomBy = (factor: number) => {
    setView((prev) => {
      const scale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = scale / prev.scale;
      const cx = size.width / 2;
      const cy = size.height / 2;
      return { scale, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
    });
  };

  const centerOn = (id: string) => {
    const node = nodeMap.get(id);
    if (!node || !size.width || !size.height) return;
    setView((prev) => {
      const scale = clamp(Math.max(prev.scale, 0.9), MIN_SCALE, MAX_SCALE);
      return { scale, x: size.width / 2 - node.x * scale, y: size.height / 2 - node.y * scale };
    });
  };

  const handleMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    setIsDragging(true);
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setView((prev) => ({
      ...prev,
      x: drag.originX + (event.clientX - drag.pointerX),
      y: drag.originY + (event.clientY - drag.pointerY),
    }));
  };

  const handleMouseUp = () => {
    dragRef.current = null;
    setIsDragging(false);
  };

  const resetView = () => {
    setFilterMode("all");
    setQuery("");
    fitTo(layout.positioned);
  };

  const getNodeStyles = (node: GraphNode, isSelected: boolean) => {
    let strokeColor = "#E5E4DE";
    let fillColor = "#FFFFFF";
    let badgeColor = "#777A73";

    if (node.type === "conflict" || node.status === "invalidating" || node.status === "fatal") {
      strokeColor = "#A8423F";
      fillColor = "#F9ECEB";
      badgeColor = "#A8423F";
    } else if (node.status === "threatened" || node.status === "repairing") {
      strokeColor = "#B58533";
      fillColor = "#FAF4E8";
      badgeColor = "#B58533";
    } else if (node.status === "committed" || node.status === "done" || node.status === "safe") {
      strokeColor = "#52745B";
      fillColor = "#EEF3EE";
      badgeColor = "#52745B";
    }

    if (isSelected) {
      strokeColor = "#252722";
    }

    return { strokeColor, fillColor, badgeColor };
  };

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const selectedRelations = useMemo(() => {
    if (!selectedNodeId) return [];
    return initialEdges.filter((e) => e.source === selectedNodeId || e.target === selectedNodeId);
  }, [initialEdges, selectedNodeId]);
  const selectedMeta = selectedNode
    ? Object.entries(selectedNode.metadata ?? {}).filter(
        ([, value]) => value !== null && value !== undefined && typeof value !== "object"
      )
    : [];

  const hasConflicts = totals.conflict > 0;
  const emptyMessage = !visibleNodes.length
    ? filterMode === "conflicts_only"
      ? "No conflict nodes in this graph. Conflict adjudications are not persisted by the backend, so this view stays empty in live mode."
      : `No node matches “${query.trim()}”.`
    : null;

  return (
    <div
      ref={containerRef}
      className={clsx(
        "relative w-full h-[520px] bg-[#F6F5F1] border border-[#E5E4DE] rounded-md overflow-hidden select-none",
        className
      )}
    >
      {/* Controls Bar */}
      <div className="absolute top-3 left-3 right-3 z-10 flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur-xs border border-[#E5E4DE] rounded px-2 py-1 shadow-xs text-xs">
          <button
            onClick={() => zoomBy(1.2)}
            className="p-1 text-[#777A73] hover:text-[#252722] hover:bg-[#F0EFEA] rounded"
            title="Zoom In"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => zoomBy(1 / 1.2)}
            className="p-1 text-[#777A73] hover:text-[#252722] hover:bg-[#F0EFEA] rounded"
            title="Zoom Out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={resetView}
            className="p-1 text-[#777A73] hover:text-[#252722] hover:bg-[#F0EFEA] rounded"
            title="Zoom to fit"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <div className="h-3 w-[1px] bg-[#E5E4DE] mx-1" />
          <span className="text-[11px] text-[#777A73] font-mono">{Math.round(view.scale * 100)}%</span>
          <div className="h-3 w-[1px] bg-[#E5E4DE] mx-1" />
          <span className="text-[11px] text-[#777A73] font-mono whitespace-nowrap">
            A {totals.agent} · I {totals.intent} · R {totals.resource}
            {hasConflicts ? ` · C ${totals.conflict}` : ""} · E {initialEdges.length}
          </span>
        </div>

        <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur-xs border border-[#E5E4DE] rounded px-2 py-1 shadow-xs text-xs">
          <Search className="w-3.5 h-3.5 text-[#777A73] shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agent, intent or resource"
            className="w-[190px] bg-transparent text-[11px] text-[#252722] placeholder:text-[#A4A89E] focus:outline-none"
            aria-label="Search graph nodes"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="p-0.5 text-[#777A73] hover:text-[#252722] hover:bg-[#F0EFEA] rounded"
              title="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur-xs border border-[#E5E4DE] rounded px-2.5 py-1 text-xs">
          <Filter className="w-3.5 h-3.5 text-[#777A73]" />
          <button
            onClick={() => setFilterMode("all")}
            className={clsx(
              "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
              filterMode === "all" ? "bg-[#242622] text-white" : "text-[#777A73] hover:text-[#252722]"
            )}
          >
            All Nodes ({initialNodes.length})
          </button>
          <button
            onClick={() => setFilterMode("conflicts_only")}
            className={clsx(
              "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
              filterMode === "conflicts_only"
                ? "bg-[#A8423F] text-white"
                : "text-[#777A73] hover:text-[#252722]"
            )}
            title="Conflict records and the nodes they touch"
          >
            Conflicts Only ({conflictNodeIds.size})
          </button>
        </div>
      </div>

      {/* Interactive SVG Canvas */}
      <svg
        className={clsx("w-full h-full", isDragging ? "cursor-grabbing" : "cursor-grab")}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#E5E4DE" strokeWidth="0.5" />
          </pattern>
          <marker
            id="arrow-safe"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#777A73" />
          </marker>
          <marker
            id="arrow-threatened"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#B58533" />
          </marker>
          <marker
            id="arrow-invalidated"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#A8423F" />
          </marker>
        </defs>

        {/* Background Grid */}
        <rect width="100%" height="100%" fill="url(#grid)" />

        <g transform={`translate(${view.x}, ${view.y}) scale(${view.scale})`}>
          {/* Column Group Labels */}
          {layout.headers.map((header) => (
            <text
              key={header.title}
              x={header.x}
              y={header.y}
              fill="#777A73"
              fontSize="11"
              fontWeight="600"
              letterSpacing="0.05em"
            >
              {header.title} ({header.count})
            </text>
          ))}

          {/* Edges */}
          {visibleEdges.map((edge) => {
            const sourceNode = nodeMap.get(edge.source);
            const targetNode = nodeMap.get(edge.target);
            if (!sourceNode || !targetNode) return null;

            const isEdgeInvalidated = edge.status === "invalidated";
            const isEdgeThreatened = edge.status === "threatened";

            let edgeColor = "#A4A89E";
            let markerId = "arrow-safe";
            let dashArray = "none";

            if (isEdgeInvalidated) {
              edgeColor = "#A8423F";
              markerId = "arrow-invalidated";
              dashArray = "4,3";
            } else if (isEdgeThreatened) {
              edgeColor = "#B58533";
              markerId = "arrow-threatened";
              dashArray = "4,2";
            }

            // Bezier curve between facing card edges.
            const sx = sourceNode.x + NODE_W / 2;
            const sy = sourceNode.y + NODE_H / 2;
            const tx = targetNode.x - NODE_W / 2;
            const ty = targetNode.y + NODE_H / 2;
            const mx = (sx + tx) / 2;

            return (
              <g key={edge.id}>
                <path
                  d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`}
                  fill="none"
                  stroke={edgeColor}
                  strokeWidth={isEdgeInvalidated || isEdgeThreatened ? 2 : 1.2}
                  strokeDasharray={dashArray}
                  markerEnd={`url(#${markerId})`}
                />
                {edge.label && (
                  <text
                    x={mx}
                    y={(sy + ty) / 2 - 6}
                    fill={isEdgeInvalidated ? "#872B28" : "#777A73"}
                    fontSize="9.5"
                    fontFamily="monospace"
                    textAnchor="middle"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {visibleNodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            const isMatch = matchIds?.has(node.id) ?? false;
            const { strokeColor, fillColor, badgeColor } = getNodeStyles(node, isSelected);

            return (
              <g
                key={node.id}
                transform={`translate(${node.x - NODE_W / 2}, ${node.y})`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectNode?.(isSelected ? null : node);
                }}
                className="cursor-pointer"
              >
                <title>{node.label}</title>
                {isMatch && (
                  <rect
                    x="-3"
                    y="-3"
                    width={NODE_W + 6}
                    height={NODE_H + 6}
                    rx="8"
                    fill="none"
                    stroke="#52745B"
                    strokeWidth="1.5"
                    strokeDasharray="3,2"
                  />
                )}
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx="6"
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={isSelected ? 2 : 1}
                />
                <rect width="4" height={NODE_H} rx="2" fill={badgeColor} />
                <text
                  x="14"
                  y="20"
                  fill="#252722"
                  fontSize="11"
                  fontWeight="600"
                  fontFamily="-apple-system, sans-serif"
                >
                  {node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label}
                </text>
                <text x="14" y="36" fill="#777A73" fontSize="9.5" fontFamily="monospace">
                  {node.type.toUpperCase()}
                  {node.status ? ` · ${node.status}` : ""}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {emptyMessage && (
        <div className="absolute inset-0 z-0 flex items-center justify-center px-10 pointer-events-none">
          <p className="max-w-md text-center text-[11px] leading-relaxed text-[#777A73] bg-white/90 border border-[#E5E4DE] rounded px-3 py-2">
            {emptyMessage}
          </p>
        </div>
      )}

      {/* Selected Node Details */}
      {selectedNode && (
        <div className="absolute bottom-3 right-3 z-20 w-[290px] max-h-[320px] overflow-y-auto bg-white border border-[#E5E4DE] rounded shadow-sm">
          <div className="flex items-start justify-between gap-2 px-3 py-2 border-b border-[#E5E4DE]">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-[#252722] break-words">
                {selectedNode.label}
              </div>
              <div className="text-[10px] font-mono text-[#777A73]">
                {selectedNode.type.toUpperCase()}
                {selectedNode.status ? ` · ${selectedNode.status}` : ""}
              </div>
            </div>
            <button
              onClick={() => onSelectNode?.(null)}
              className="p-0.5 shrink-0 text-[#777A73] hover:text-[#252722] hover:bg-[#F0EFEA] rounded"
              title="Close details"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          <div className="px-3 py-2 space-y-1.5 border-b border-[#E5E4DE]">
            <div className="flex items-start justify-between gap-2 text-[10.5px]">
              <span className="text-[#777A73] shrink-0">Record ID</span>
              <span className="font-mono text-[#252722] break-all text-right">
                {selectedNode.id.replace(/^(agent|intent|res|conf):/, "")}
              </span>
            </div>
            {selectedMeta.map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-2 text-[10.5px]">
                <span className="text-[#777A73] shrink-0 capitalize">{key}</span>
                <span className="font-mono text-[#252722] break-words text-right">
                  {String(value)}
                </span>
              </div>
            ))}
          </div>

          <div className="px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#777A73] mb-1">
              Relationships ({selectedRelations.length})
            </div>
            {selectedRelations.length === 0 ? (
              <p className="text-[10.5px] text-[#777A73]">
                No stored relationship references this record.
              </p>
            ) : (
              <ul className="space-y-1">
                {selectedRelations.slice(0, 8).map((edge) => {
                  const outgoing = edge.source === selectedNode.id;
                  const otherId = outgoing ? edge.target : edge.source;
                  const other = nodeMap.get(otherId);
                  return (
                    <li key={edge.id}>
                      <button
                        onClick={() => {
                          if (other) {
                            onSelectNode?.(other);
                            centerOn(other.id);
                          }
                        }}
                        className="w-full flex items-start gap-1.5 text-left text-[10.5px] text-[#252722] hover:bg-[#F0EFEA] rounded px-1 py-0.5"
                      >
                        {outgoing ? (
                          <ArrowRight className="w-3 h-3 mt-0.5 shrink-0 text-[#52745B]" />
                        ) : (
                          <ArrowLeft className="w-3 h-3 mt-0.5 shrink-0 text-[#777A73]" />
                        )}
                        <span className="min-w-0">
                          <span className="font-mono text-[10px] text-[#777A73]">
                            {edge.label ?? (outgoing ? "references" : "referenced by")}
                          </span>
                          <span className="block truncate">{other?.label ?? otherId}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {selectedRelations.length > 8 && (
                  <li className="text-[10px] text-[#777A73] px-1">
                    +{selectedRelations.length - 8} more
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-10 bg-white/95 backdrop-blur-xs border border-[#E5E4DE] rounded px-3 py-1.5 shadow-xs flex items-center gap-4 text-[11px] text-[#252722]">
        <span className="font-semibold text-[#777A73]">LEGEND:</span>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#52745B]" />
          <span>Committed / Safe</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#B58533]" />
          <span>Threatened / Version drift</span>
        </div>
        {hasConflicts && (
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#A8423F]" />
            <span>Conflict node</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#777A73]" />
          <span>Stable record</span>
        </div>
        <span className="text-[10px] font-mono text-[#777A73]">
          {visibleNodes.length}/{initialNodes.length} shown
          {visibleEdges.length !== initialEdges.length ? ` · ${visibleEdges.length}/${initialEdges.length} edges` : ""}
          {unresolvedEdges > 0 ? ` · ${unresolvedEdges} unresolved` : ""}
        </span>
      </div>
    </div>
  );
};
