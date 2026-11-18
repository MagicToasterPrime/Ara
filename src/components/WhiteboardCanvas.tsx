"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { io, type Socket } from "socket.io-client";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Circle,
  Copy,
  Diamond,
  Download,
  Eraser,
  Focus,
  Grid3X3,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Layers,
  Minus,
  MousePointer2,
  Pen,
  Redo2,
  Save,
  Square,
  StickyNote,
  Tag,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import type {
  WhiteboardCollaborator,
  WhiteboardCursorPayload,
  WhiteboardUpdatePayload,
} from "@/lib/socket-types";

interface WhiteboardCanvasProps {
  whiteboardId: string;
  initialSnapshot: string;
  userId: string;
  userName: string;
}

export type ToolType =
  | "select"
  | "hand"
  | "pen"
  | "highlighter"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "diamond"
  | "text"
  | "sticky"
  | "callout"
  | "eraser";

export type BoardBackground = "DOTS" | "GRID" | "RULED" | "PLAIN";
export type StrokeDash = "solid" | "dashed" | "dotted";

export interface BoardPoint {
  x: number;
  y: number;
}

interface BaseElement {
  id: string;
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  dash: StrokeDash;
  opacity: number;
  createdBy?: string;
}

export interface FreehandElement extends BaseElement {
  type: "pen" | "highlighter";
  points: BoardPoint[];
}

export interface ConnectorElement extends BaseElement {
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BoxElement extends BaseElement {
  type: "rect" | "ellipse" | "diamond" | "sticky";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

export interface TextElement extends BaseElement {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

export interface CalloutElement extends BaseElement {
  type: "callout";
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  number: number;
  label: string;
}

export interface ImageElement extends BaseElement {
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string;
  caption: string;
}

export type WhiteboardElement =
  | FreehandElement
  | ConnectorElement
  | BoxElement
  | TextElement
  | CalloutElement
  | ImageElement;

export interface AraWhiteboardSnapshot {
  version: 2;
  background: BoardBackground;
  elements: WhiteboardElement[];
}

interface RemoteCursorState {
  socketId: string;
  userId: string;
  userName: string;
  color: string;
  x: number;
  y: number;
  updatedAt: number;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const COLLABORATOR_COLORS = [
  "#D99B26",
  "#C83E4D",
  "#3B7A57",
  "#3D6B99",
  "#2B547E",
];

const STROKE_COLORS = [
  { label: "Encre noire", hex: "#1A1A1A" },
  { label: "Pierre grise", hex: "#6E6D68" },
  { label: "Ambre", hex: "#D99B26" },
  { label: "Carmin", hex: "#C83E4D" },
  { label: "Vert forêt", hex: "#3B7A57" },
  { label: "Bleu ardoise", hex: "#3D6B99" },
  { label: "Bleu validation", hex: "#2B547E" },
];

const FILL_COLORS = [
  { label: "Aucun", hex: "transparent" },
  { label: "Papier clair", hex: "#FCFBF9" },
  { label: "Crème chaud", hex: "#F4EFE6" },
  { label: "Bleu badge", hex: "#E8F0F8" },
  { label: "Ambre doux", hex: "#FDF3DF" },
  { label: "Vert doux", hex: "#EAF4EE" },
  { label: "Carmin doux", hex: "#FBEAEC" },
];

const STROKE_WIDTHS = [2, 4, 7, 12];

const BACKGROUND_LABELS: Record<BoardBackground, string> = {
  DOTS: "POINTS",
  GRID: "GRILLE",
  RULED: "LIGNES",
  PLAIN: "VIERGE",
};

function pickColorForUser(id: string): string {
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) {
    sum += id.charCodeAt(i);
  }
  return COLLABORATOR_COLORS[sum % COLLABORATOR_COLORS.length];
}

function makeId(): string {
  return `el-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function parseSnapshot(raw: string): AraWhiteboardSnapshot {
  if (!raw || raw === "{}") {
    return { version: 2, background: "DOTS", elements: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AraWhiteboardSnapshot>;
    if (
      parsed &&
      parsed.version === 2 &&
      Array.isArray(parsed.elements)
    ) {
      const bg: BoardBackground =
        parsed.background === "GRID" ||
        parsed.background === "RULED" ||
        parsed.background === "PLAIN" ||
        parsed.background === "DOTS"
          ? parsed.background
          : "DOTS";
      return {
        version: 2,
        background: bg,
        elements: parsed.elements,
      };
    }
  } catch {
    // Fallback cleanly for legacy/empty snapshots
  }
  return { version: 2, background: "DOTS", elements: [] };
}

function getDashArray(dash: StrokeDash, width: number): string | undefined {
  if (dash === "dashed") return `${Math.max(8, width * 3)} ${Math.max(5, width * 2)}`;
  if (dash === "dotted") return `${Math.max(2, width)} ${Math.max(4, width * 1.8)}`;
  return undefined;
}

function pointsToSmoothPath(points: BoardPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.5} ${points[0].y + 0.5}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y}, ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function getElementBounds(el: WhiteboardElement): BoundingBox {
  switch (el.type) {
    case "pen":
    case "highlighter": {
      if (el.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      let minX = el.points[0].x;
      let maxX = el.points[0].x;
      let minY = el.points[0].y;
      let maxY = el.points[0].y;
      for (const pt of el.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
      return {
        x: minX,
        y: minY,
        width: Math.max(8, maxX - minX),
        height: Math.max(8, maxY - minY),
      };
    }
    case "line":
    case "arrow": {
      const minX = Math.min(el.x1, el.x2);
      const minY = Math.min(el.y1, el.y2);
      return {
        x: minX,
        y: minY,
        width: Math.max(4, Math.abs(el.x2 - el.x1)),
        height: Math.max(4, Math.abs(el.y2 - el.y1)),
      };
    }
    case "rect":
    case "ellipse":
    case "diamond":
    case "sticky":
    case "image":
      return {
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
      };
    case "text": {
      const lines = (el.text || "Texte").split("\n");
      const maxLen = Math.max(...lines.map((l) => l.length), 5);
      return {
        x: el.x,
        y: el.y,
        width: Math.max(80, maxLen * el.fontSize * 0.62),
        height: Math.max(28, lines.length * el.fontSize * 1.35),
      };
    }
    case "callout": {
      const minX = Math.min(el.x - 16, el.targetX);
      const minY = Math.min(el.y - 16, el.targetY);
      const maxX = Math.max(
        el.x + 16 + (el.label ? el.label.length * 7.5 + 16 : 0),
        el.targetX
      );
      const maxY = Math.max(el.y + 16, el.targetY);
      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    }
  }
}

function hitTestElement(
  el: WhiteboardElement,
  wx: number,
  wy: number,
  tolerance = 10
): boolean {
  switch (el.type) {
    case "pen":
    case "highlighter": {
      const tol = Math.max(tolerance, el.strokeWidth / 2 + 6);
      for (let i = 0; i < el.points.length - 1; i += 1) {
        if (
          distToSegment(
            wx,
            wy,
            el.points[i].x,
            el.points[i].y,
            el.points[i + 1].x,
            el.points[i + 1].y
          ) <= tol
        ) {
          return true;
        }
      }
      if (el.points.length === 1) {
        return Math.hypot(wx - el.points[0].x, wy - el.points[0].y) <= tol;
      }
      return false;
    }
    case "line":
    case "arrow":
      return (
        distToSegment(wx, wy, el.x1, el.y1, el.x2, el.y2) <=
        Math.max(tolerance, el.strokeWidth + 6)
      );
    case "rect":
    case "ellipse":
    case "diamond":
    case "sticky":
    case "image":
      return (
        wx >= el.x - 6 &&
        wx <= el.x + el.width + 6 &&
        wy >= el.y - 6 &&
        wy <= el.y + el.height + 6
      );
    case "text": {
      const b = getElementBounds(el);
      return (
        wx >= b.x - 6 &&
        wx <= b.x + b.width + 6 &&
        wy >= b.y - 6 &&
        wy <= b.y + b.height + 6
      );
    }
    case "callout": {
      const nearBadge = Math.hypot(wx - el.x, wy - el.y) <= 22;
      const nearLine =
        distToSegment(wx, wy, el.x, el.y, el.targetX, el.targetY) <= 10;
      const inLabel =
        Boolean(el.label) &&
        wx >= el.x + 14 &&
        wx <= el.x + 24 + el.label.length * 8 &&
        wy >= el.y - 16 &&
        wy <= el.y + 16;
      return nearBadge || nearLine || inLabel;
    }
  }
}

function translateElement(
  el: WhiteboardElement,
  dx: number,
  dy: number
): WhiteboardElement {
  switch (el.type) {
    case "pen":
    case "highlighter":
      return {
        ...el,
        points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      };
    case "line":
    case "arrow":
      return {
        ...el,
        x1: el.x1 + dx,
        y1: el.y1 + dy,
        x2: el.x2 + dx,
        y2: el.y2 + dy,
      };
    case "rect":
    case "ellipse":
    case "diamond":
    case "sticky":
    case "image":
    case "text":
      return {
        ...el,
        x: el.x + dx,
        y: el.y + dy,
      };
    case "callout":
      return {
        ...el,
        x: el.x + dx,
        y: el.y + dy,
        targetX: el.targetX + dx,
        targetY: el.targetY + dy,
      };
  }
}

function getLayerLabel(el: WhiteboardElement): string {
  switch (el.type) {
    case "pen":
      return "TRACÉ STYLO";
    case "highlighter":
      return "SURLIGNAGE";
    case "line":
      return "SEGMENT";
    case "arrow":
      return "FLÈCHE";
    case "rect":
      return el.text ? `RECT · ${el.text.slice(0, 16)}` : "RECTANGLE";
    case "ellipse":
      return el.text ? `ELLIPSE · ${el.text.slice(0, 16)}` : "ELLIPSE";
    case "diamond":
      return el.text ? `LOSANGE · ${el.text.slice(0, 16)}` : "LOSANGE";
    case "sticky":
      return el.text ? `NOTE · ${el.text.slice(0, 16)}` : "POST-IT";
    case "text":
      return el.text ? `TEXTE · ${el.text.slice(0, 16)}` : "TEXTE";
    case "callout":
      return `REPÈRE #${el.number}${el.label ? ` · ${el.label}` : ""}`;
    case "image":
      return el.caption ? `IMAGE · ${el.caption.slice(0, 16)}` : "IMAGE";
  }
}

type ActiveGesture =
  | {
      kind: "pan";
      startClientX: number;
      startClientY: number;
      originCamX: number;
      originCamY: number;
    }
  | {
      kind: "draw";
      elementId: string;
      startX: number;
      startY: number;
    }
  | {
      kind: "move";
      elementId: string;
      startWorldX: number;
      startWorldY: number;
      originElement: WhiteboardElement;
    }
  | {
      kind: "resize-box";
      elementId: string;
      handle: "nw" | "ne" | "sw" | "se";
      originX: number;
      originY: number;
      originW: number;
      originH: number;
    }
  | {
      kind: "move-endpoint";
      elementId: string;
      which: "start" | "end" | "target" | "badge";
    }
  | {
      kind: "erase";
      erasedIds: Set<string>;
    };

export function WhiteboardCanvas({
  whiteboardId,
  initialSnapshot,
  userId,
  userName,
}: WhiteboardCanvasProps) {
  const initialParsed = useMemo(
    () => parseSnapshot(initialSnapshot),
    [initialSnapshot]
  );

  const [snapshot, setSnapshot] = useState<AraWhiteboardSnapshot>(initialParsed);
  const snapshotRef = useRef<AraWhiteboardSnapshot>(initialParsed);
  const undoStackRef = useRef<AraWhiteboardSnapshot[]>([]);
  const redoStackRef = useRef<AraWhiteboardSnapshot[]>([]);
  const [historyMeta, setHistoryMeta] = useState({ undo: 0, redo: 0 });

  const [tool, setTool] = useState<ToolType>("pen");
  const [strokeColor, setStrokeColor] = useState<string>("#1A1A1A");
  const [fillColor, setFillColor] = useState<string>("transparent");
  const [strokeWidth, setStrokeWidth] = useState<number>(2);
  const [dash, setDash] = useState<StrokeDash>("solid");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string>("");
  const [showLayers, setShowLayers] = useState(false);

  const [camera, setCamera] = useState<{ x: number; y: number; zoom: number }>({
    x: 0,
    y: 0,
    zoom: 1,
  });

  const [collaborators, setCollaborators] = useState<WhiteboardCollaborator[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<
    Record<string, RemoteCursorState>
  >({});
  const [saveStatus, setSaveStatus] = useState<string>("SYNCHRONISÉ");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBroadcastRef = useRef(0);
  const lastCursorSentRef = useRef(0);
  const myColor = pickColorForUser(userId);

  const syncHistoryCounts = useCallback(() => {
    setHistoryMeta({
      undo: undoStackRef.current.length,
      redo: redoStackRef.current.length,
    });
  }, []);

  const persistSnapshot = useCallback(
    async (snapshotString: string) => {
      try {
        setSaveStatus("SAUVEGARDE...");
        const res = await fetch(`/api/whiteboards/${whiteboardId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snapshotData: snapshotString }),
        });
        if (res.ok) {
          const now = new Date().toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          setSaveStatus(`SAUVEGARDÉ EN POSTGRESQL · ${now}`);
        } else {
          setSaveStatus("ERREUR DE SAUVEGARDE");
        }
      } catch {
        setSaveStatus("ERREUR RÉSEAU");
      }
    },
    [whiteboardId]
  );

  const broadcastAndScheduleSave = useCallback(
    (next: AraWhiteboardSnapshot, immediateSave = false) => {
      const serialized = JSON.stringify(next);
      const now = Date.now();

      if (
        socketRef.current &&
        (immediateSave || now - lastBroadcastRef.current >= 110)
      ) {
        lastBroadcastRef.current = now;
        socketRef.current.emit("whiteboard-update", {
          whiteboardId,
          userId,
          snapshot: serialized,
        });
      }

      setSaveStatus("MODIFICATIONS EN ATTENTE...");
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      if (immediateSave) {
        void persistSnapshot(serialized);
        return;
      }

      saveTimerRef.current = setTimeout(() => {
        if (socketRef.current) {
          socketRef.current.emit("whiteboard-update", {
            whiteboardId,
            userId,
            snapshot: serialized,
          });
        }
        void persistSnapshot(serialized);
      }, 3000);
    },
    [persistSnapshot, userId, whiteboardId]
  );

  const commitSnapshot = useCallback(
    (
      next: AraWhiteboardSnapshot,
      options?: { pushUndo?: boolean; prevForUndo?: AraWhiteboardSnapshot }
    ) => {
      if (options?.pushUndo !== false) {
        undoStackRef.current.push(options?.prevForUndo ?? snapshotRef.current);
        if (undoStackRef.current.length > 60) {
          undoStackRef.current.shift();
        }
        redoStackRef.current = [];
        syncHistoryCounts();
      }
      snapshotRef.current = next;
      setSnapshot(next);
      broadcastAndScheduleSave(next);
    },
    [broadcastAndScheduleSave, syncHistoryCounts]
  );

  const updateLiveSnapshot = useCallback(
    (next: AraWhiteboardSnapshot) => {
      snapshotRef.current = next;
      setSnapshot(next);
      const serialized = JSON.stringify(next);
      const now = Date.now();
      if (socketRef.current && now - lastBroadcastRef.current >= 120) {
        lastBroadcastRef.current = now;
        socketRef.current.emit("whiteboard-update", {
          whiteboardId,
          userId,
          snapshot: serialized,
        });
      }
    },
    [userId, whiteboardId]
  );

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push(snapshotRef.current);
    syncHistoryCounts();
    snapshotRef.current = prev;
    setSnapshot(prev);
    broadcastAndScheduleSave(prev);
  }, [broadcastAndScheduleSave, syncHistoryCounts]);

  const handleRedo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(snapshotRef.current);
    syncHistoryCounts();
    snapshotRef.current = next;
    setSnapshot(next);
    broadcastAndScheduleSave(next);
  }, [broadcastAndScheduleSave, syncHistoryCounts]);

  const selectedElement = useMemo(
    () => snapshot.elements.find((el) => el.id === selectedId) || null,
    [snapshot.elements, selectedId]
  );

  const deleteElementById = useCallback(
    (id: string) => {
      const next: AraWhiteboardSnapshot = {
        ...snapshotRef.current,
        elements: snapshotRef.current.elements.filter((el) => el.id !== id),
      };
      commitSnapshot(next);
      if (selectedId === id) setSelectedId(null);
      if (editingTextId === id) setEditingTextId(null);
    },
    [commitSnapshot, editingTextId, selectedId]
  );

  const duplicateSelected = useCallback(() => {
    if (!selectedElement) return;
    const copy: WhiteboardElement = {
      ...translateElement(selectedElement, 24, 24),
      id: makeId(),
    };
    const next: AraWhiteboardSnapshot = {
      ...snapshotRef.current,
      elements: [...snapshotRef.current.elements, copy],
    };
    commitSnapshot(next);
    setSelectedId(copy.id);
  }, [commitSnapshot, selectedElement]);

  // Socket.io connection for live collaboration & world-space cursors
  useEffect(() => {
    const socket = io({
      path: "/api/socketio",
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-whiteboard", {
        whiteboardId,
        userId,
        userName,
        color: myColor,
      });
    });

    socket.on("whiteboard-presence", (list: WhiteboardCollaborator[]) => {
      setCollaborators(list);
    });

    socket.on(
      "whiteboard-remote-cursor",
      (payload: WhiteboardCursorPayload & { socketId: string }) => {
        if (payload.userId === userId) return;
        setRemoteCursors((prev) => ({
          ...prev,
          [payload.socketId]: {
            socketId: payload.socketId,
            userId: payload.userId,
            userName: payload.userName,
            color: payload.color,
            x: payload.x,
            y: payload.y,
            updatedAt: Date.now(),
          },
        }));
      }
    );

    socket.on(
      "whiteboard-remote-update",
      (payload: WhiteboardUpdatePayload) => {
        if (payload.userId === userId || gestureRef.current) return;
        const parsed = parseSnapshot(payload.snapshot);
        snapshotRef.current = parsed;
        setSnapshot(parsed);
      }
    );

    const pruneInterval = setInterval(() => {
      const cutoff = Date.now() - 8000;
      setRemoteCursors((prev) => {
        const next: Record<string, RemoteCursorState> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (v.updatedAt >= cutoff) {
            next[k] = v;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 3000);

    return () => {
      clearInterval(pruneInterval);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      socket.emit("leave-whiteboard", whiteboardId);
      socket.disconnect();
    };
  }, [whiteboardId, userId, userName, myColor]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        Boolean(editingTextId);
      if (inInput) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && selectedId) {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteElementById(selectedId);
        return;
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        setTool("select");
        return;
      }

      const keyMap: Record<string, ToolType> = {
        v: "select",
        h: "hand",
        p: "pen",
        m: "highlighter",
        l: "line",
        a: "arrow",
        r: "rect",
        o: "ellipse",
        d: "diamond",
        t: "text",
        n: "sticky",
        c: "callout",
        e: "eraser",
      };
      const mapped = keyMap[e.key.toLowerCase()];
      if (mapped && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setTool(mapped);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    deleteElementById,
    duplicateSelected,
    editingTextId,
    handleRedo,
    handleUndo,
    selectedId,
  ]);

  function clientToWorld(clientX: number, clientY: number): BoardPoint {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - camera.x) / camera.zoom,
      y: (clientY - rect.top - camera.y) / camera.zoom,
    };
  }

  function startInlineTextEdit(el: WhiteboardElement) {
    setEditingTextId(el.id);
    if (el.type === "callout") {
      setDraftText(el.label);
    } else if (el.type === "image") {
      setDraftText(el.caption);
    } else if (
      el.type === "rect" ||
      el.type === "ellipse" ||
      el.type === "diamond" ||
      el.type === "sticky" ||
      el.type === "text"
    ) {
      setDraftText(el.text);
    }
  }

  function finishInlineTextEdit(commit = true) {
    if (!editingTextId) return;
    if (commit) {
      const nextElements = snapshotRef.current.elements.map((el) => {
        if (el.id !== editingTextId) return el;
        if (el.type === "callout") {
          return { ...el, label: draftText.trim() };
        }
        if (el.type === "image") {
          return { ...el, caption: draftText.trim() };
        }
        if (
          el.type === "rect" ||
          el.type === "ellipse" ||
          el.type === "diamond" ||
          el.type === "sticky" ||
          el.type === "text"
        ) {
          return { ...el, text: draftText };
        }
        return el;
      });
      commitSnapshot({ ...snapshotRef.current, elements: nextElements });
    }
    setEditingTextId(null);
  }

  function handleCanvasPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (editingTextId) {
      finishInlineTextEdit(true);
    }

    const container = containerRef.current;
    if (!container) return;
    container.setPointerCapture(e.pointerId);

    const world = clientToWorld(e.clientX, e.clientY);

    // Middle-mouse button or Hand tool starts panning
    if (e.button === 1 || tool === "hand") {
      gestureRef.current = {
        kind: "pan",
        startClientX: e.clientX,
        startClientY: e.clientY,
        originCamX: camera.x,
        originCamY: camera.y,
      };
      return;
    }

    if (e.button !== 0) return;

    if (tool === "eraser") {
      const hit = [...snapshotRef.current.elements]
        .reverse()
        .find((el) => hitTestElement(el, world.x, world.y, 12));
      const erasedIds = new Set<string>();
      if (hit) {
        erasedIds.add(hit.id);
        undoStackRef.current.push(snapshotRef.current);
        redoStackRef.current = [];
        syncHistoryCounts();
        const next: AraWhiteboardSnapshot = {
          ...snapshotRef.current,
          elements: snapshotRef.current.elements.filter((el) => el.id !== hit.id),
        };
        updateLiveSnapshot(next);
        if (selectedId === hit.id) setSelectedId(null);
      }
      gestureRef.current = { kind: "erase", erasedIds };
      return;
    }

    if (tool === "select") {
      // Check resize / endpoint handles on selected element first
      if (selectedElement) {
        const handleRadius = 10 / camera.zoom;
        if (
          selectedElement.type === "rect" ||
          selectedElement.type === "ellipse" ||
          selectedElement.type === "diamond" ||
          selectedElement.type === "sticky" ||
          selectedElement.type === "image"
        ) {
          const corners: Array<{
            name: "nw" | "ne" | "sw" | "se";
            hx: number;
            hy: number;
          }> = [
            { name: "nw", hx: selectedElement.x, hy: selectedElement.y },
            {
              name: "ne",
              hx: selectedElement.x + selectedElement.width,
              hy: selectedElement.y,
            },
            {
              name: "sw",
              hx: selectedElement.x,
              hy: selectedElement.y + selectedElement.height,
            },
            {
              name: "se",
              hx: selectedElement.x + selectedElement.width,
              hy: selectedElement.y + selectedElement.height,
            },
          ];
          const hitCorner = corners.find(
            (c) => Math.hypot(world.x - c.hx, world.y - c.hy) <= handleRadius
          );
          if (hitCorner) {
            undoStackRef.current.push(snapshotRef.current);
            redoStackRef.current = [];
            syncHistoryCounts();
            gestureRef.current = {
              kind: "resize-box",
              elementId: selectedElement.id,
              handle: hitCorner.name,
              originX: selectedElement.x,
              originY: selectedElement.y,
              originW: selectedElement.width,
              originH: selectedElement.height,
            };
            return;
          }
        } else if (
          selectedElement.type === "line" ||
          selectedElement.type === "arrow"
        ) {
          if (
            Math.hypot(
              world.x - selectedElement.x1,
              world.y - selectedElement.y1
            ) <= handleRadius
          ) {
            undoStackRef.current.push(snapshotRef.current);
            redoStackRef.current = [];
            syncHistoryCounts();
            gestureRef.current = {
              kind: "move-endpoint",
              elementId: selectedElement.id,
              which: "start",
            };
            return;
          }
          if (
            Math.hypot(
              world.x - selectedElement.x2,
              world.y - selectedElement.y2
            ) <= handleRadius
          ) {
            undoStackRef.current.push(snapshotRef.current);
            redoStackRef.current = [];
            syncHistoryCounts();
            gestureRef.current = {
              kind: "move-endpoint",
              elementId: selectedElement.id,
              which: "end",
            };
            return;
          }
        } else if (selectedElement.type === "callout") {
          if (
            Math.hypot(
              world.x - selectedElement.targetX,
              world.y - selectedElement.targetY
            ) <= handleRadius
          ) {
            undoStackRef.current.push(snapshotRef.current);
            redoStackRef.current = [];
            syncHistoryCounts();
            gestureRef.current = {
              kind: "move-endpoint",
              elementId: selectedElement.id,
              which: "target",
            };
            return;
          }
        }
      }

      const hit = [...snapshotRef.current.elements]
        .reverse()
        .find((el) => hitTestElement(el, world.x, world.y, 10 / camera.zoom));

      if (hit) {
        setSelectedId(hit.id);
        undoStackRef.current.push(snapshotRef.current);
        redoStackRef.current = [];
        syncHistoryCounts();
        gestureRef.current = {
          kind: "move",
          elementId: hit.id,
          startWorldX: world.x,
          startWorldY: world.y,
          originElement: hit,
        };
      } else {
        setSelectedId(null);
      }
      return;
    }

    if (tool === "text") {
      const id = makeId();
      const newText: TextElement = {
        id,
        type: "text",
        x: Math.round(world.x),
        y: Math.round(world.y),
        text: "Texte",
        fontSize: Math.max(16, strokeWidth * 4 + 8),
        strokeColor,
        fillColor: "transparent",
        strokeWidth,
        dash: "solid",
        opacity: 1,
        createdBy: userName,
      };
      commitSnapshot({
        ...snapshotRef.current,
        elements: [...snapshotRef.current.elements, newText],
      });
      setSelectedId(id);
      setTool("select");
      setEditingTextId(id);
      setDraftText("");
      return;
    }

    if (tool === "sticky") {
      const id = makeId();
      const stickyFill =
        fillColor === "transparent" ? "#FDF3DF" : fillColor;
      const newSticky: BoxElement = {
        id,
        type: "sticky",
        x: Math.round(world.x - 95),
        y: Math.round(world.y - 65),
        width: 190,
        height: 130,
        text: "",
        strokeColor: strokeColor === "#FCFBF9" ? "#1A1A1A" : strokeColor,
        fillColor: stickyFill,
        strokeWidth: 1.5,
        dash: "solid",
        opacity: 1,
        createdBy: userName,
      };
      commitSnapshot({
        ...snapshotRef.current,
        elements: [...snapshotRef.current.elements, newSticky],
      });
      setSelectedId(id);
      setTool("select");
      setEditingTextId(id);
      setDraftText("");
      return;
    }

    // Continuous drawing tools: pen, highlighter, line, arrow, rect, ellipse, diamond, callout
    const id = makeId();
    let newEl: WhiteboardElement | null = null;

    if (tool === "pen" || tool === "highlighter") {
      newEl = {
        id,
        type: tool,
        points: [{ x: world.x, y: world.y }],
        strokeColor,
        fillColor: "transparent",
        strokeWidth: tool === "highlighter" ? Math.max(14, strokeWidth * 4) : strokeWidth,
        dash: tool === "highlighter" ? "solid" : dash,
        opacity: tool === "highlighter" ? 0.38 : 1,
        createdBy: userName,
      };
    } else if (tool === "line" || tool === "arrow") {
      newEl = {
        id,
        type: tool,
        x1: world.x,
        y1: world.y,
        x2: world.x,
        y2: world.y,
        strokeColor,
        fillColor: "transparent",
        strokeWidth,
        dash,
        opacity: 1,
        createdBy: userName,
      };
    } else if (tool === "rect" || tool === "ellipse" || tool === "diamond") {
      newEl = {
        id,
        type: tool,
        x: world.x,
        y: world.y,
        width: 2,
        height: 2,
        text: "",
        strokeColor,
        fillColor,
        strokeWidth,
        dash,
        opacity: 1,
        createdBy: userName,
      };
    } else if (tool === "callout") {
      const existingCount = snapshotRef.current.elements.filter(
        (el) => el.type === "callout"
      ).length;
      newEl = {
        id,
        type: "callout",
        x: world.x + 48,
        y: world.y - 42,
        targetX: world.x,
        targetY: world.y,
        number: existingCount + 1,
        label: `Légende ${existingCount + 1}`,
        strokeColor,
        fillColor: "#1A1A1A",
        strokeWidth: 2,
        dash: "solid",
        opacity: 1,
        createdBy: userName,
      };
    }

    if (!newEl) return;

    undoStackRef.current.push(snapshotRef.current);
    redoStackRef.current = [];
    syncHistoryCounts();

    updateLiveSnapshot({
      ...snapshotRef.current,
      elements: [...snapshotRef.current.elements, newEl],
    });
    setSelectedId(id);

    gestureRef.current = {
      kind: "draw",
      elementId: id,
      startX: world.x,
      startY: world.y,
    };
  }

  function handleCanvasPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const world = clientToWorld(e.clientX, e.clientY);

    // Emit live world cursor throttled to 60ms
    const now = Date.now();
    if (socketRef.current && now - lastCursorSentRef.current >= 60) {
      lastCursorSentRef.current = now;
      socketRef.current.emit("whiteboard-cursor", {
        whiteboardId,
        userId,
        userName,
        color: myColor,
        x: Math.round(world.x),
        y: Math.round(world.y),
      });
    }

    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === "pan") {
      setCamera((prev) => ({
        ...prev,
        x: gesture.originCamX + (e.clientX - gesture.startClientX),
        y: gesture.originCamY + (e.clientY - gesture.startClientY),
      }));
      return;
    }

    if (gesture.kind === "erase") {
      const hit = [...snapshotRef.current.elements]
        .reverse()
        .find((el) => hitTestElement(el, world.x, world.y, 12));
      if (hit && !gesture.erasedIds.has(hit.id)) {
        if (gesture.erasedIds.size === 0) {
          undoStackRef.current.push(snapshotRef.current);
          redoStackRef.current = [];
          syncHistoryCounts();
        }
        gesture.erasedIds.add(hit.id);
        updateLiveSnapshot({
          ...snapshotRef.current,
          elements: snapshotRef.current.elements.filter(
            (el) => el.id !== hit.id
          ),
        });
      }
      return;
    }

    if (gesture.kind === "move") {
      const dx = world.x - gesture.startWorldX;
      const dy = world.y - gesture.startWorldY;
      const moved = translateElement(gesture.originElement, dx, dy);
      updateLiveSnapshot({
        ...snapshotRef.current,
        elements: snapshotRef.current.elements.map((el) =>
          el.id === gesture.elementId ? moved : el
        ),
      });
      return;
    }

    if (gesture.kind === "resize-box") {
      const minSize = 24;
      let nextX = gesture.originX;
      let nextY = gesture.originY;
      let nextW = gesture.originW;
      let nextH = gesture.originH;

      if (gesture.handle.includes("e")) {
        nextW = Math.max(minSize, world.x - gesture.originX);
      }
      if (gesture.handle.includes("s")) {
        nextH = Math.max(minSize, world.y - gesture.originY);
      }
      if (gesture.handle.includes("w")) {
        const right = gesture.originX + gesture.originW;
        nextX = Math.min(world.x, right - minSize);
        nextW = right - nextX;
      }
      if (gesture.handle.includes("n")) {
        const bottom = gesture.originY + gesture.originH;
        nextY = Math.min(world.y, bottom - minSize);
        nextH = bottom - nextY;
      }

      updateLiveSnapshot({
        ...snapshotRef.current,
        elements: snapshotRef.current.elements.map((el) => {
          if (
            el.id === gesture.elementId &&
            (el.type === "rect" ||
              el.type === "ellipse" ||
              el.type === "diamond" ||
              el.type === "sticky" ||
              el.type === "image")
          ) {
            return {
              ...el,
              x: nextX,
              y: nextY,
              width: nextW,
              height: nextH,
            };
          }
          return el;
        }),
      });
      return;
    }

    if (gesture.kind === "move-endpoint") {
      updateLiveSnapshot({
        ...snapshotRef.current,
        elements: snapshotRef.current.elements.map((el) => {
          if (el.id !== gesture.elementId) return el;
          if (el.type === "line" || el.type === "arrow") {
            return gesture.which === "start"
              ? { ...el, x1: world.x, y1: world.y }
              : { ...el, x2: world.x, y2: world.y };
          }
          if (el.type === "callout" && gesture.which === "target") {
            return { ...el, targetX: world.x, targetY: world.y };
          }
          return el;
        }),
      });
      return;
    }

    if (gesture.kind === "draw") {
      updateLiveSnapshot({
        ...snapshotRef.current,
        elements: snapshotRef.current.elements.map((el) => {
          if (el.id !== gesture.elementId) return el;
          if (el.type === "pen" || el.type === "highlighter") {
            const last = el.points[el.points.length - 1];
            if (last && Math.hypot(world.x - last.x, world.y - last.y) < 2) {
              return el;
            }
            return {
              ...el,
              points: [...el.points, { x: world.x, y: world.y }],
            };
          }
          if (el.type === "line" || el.type === "arrow") {
            return { ...el, x2: world.x, y2: world.y };
          }
          if (el.type === "rect" || el.type === "ellipse" || el.type === "diamond") {
            return {
              ...el,
              x: Math.min(gesture.startX, world.x),
              y: Math.min(gesture.startY, world.y),
              width: Math.max(8, Math.abs(world.x - gesture.startX)),
              height: Math.max(8, Math.abs(world.y - gesture.startY)),
            };
          }
          if (el.type === "callout") {
            return {
              ...el,
              x: world.x,
              y: world.y,
            };
          }
          return el;
        }),
      });
    }
  }

  function handleCanvasPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;

    try {
      containerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if not captured
    }

    if (gesture.kind === "pan") return;

    if (gesture.kind === "erase") {
      if (gesture.erasedIds.size > 0) {
        broadcastAndScheduleSave(snapshotRef.current);
      }
      return;
    }

    if (gesture.kind === "draw") {
      const created = snapshotRef.current.elements.find(
        (el) => el.id === gesture.elementId
      );
      if (
        created &&
        (created.type === "rect" ||
          created.type === "ellipse" ||
          created.type === "diamond") &&
        created.width < 12 &&
        created.height < 12
      ) {
        const sized: AraWhiteboardSnapshot = {
          ...snapshotRef.current,
          elements: snapshotRef.current.elements.map((el) =>
            el.id === created.id ? { ...el, width: 140, height: 90 } : el
          ),
        };
        snapshotRef.current = sized;
        setSnapshot(sized);
      }
      if (created?.type === "callout") {
        setTool("select");
        startInlineTextEdit(created);
      }
    }

    broadcastAndScheduleSave(snapshotRef.current);
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setCamera((prev) => {
        const nextZoom = Math.min(3, Math.max(0.25, prev.zoom * factor));
        const ratio = nextZoom / prev.zoom;
        return {
          zoom: nextZoom,
          x: mouseX - (mouseX - prev.x) * ratio,
          y: mouseY - (mouseY - prev.y) * ratio,
        };
      });
    } else {
      setCamera((prev) => ({
        ...prev,
        x: prev.x - (e.shiftKey ? e.deltaY : e.deltaX),
        y: prev.y - (e.shiftKey ? 0 : e.deltaY),
      }));
    }
  }

  function adjustZoom(delta: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 400;
    const cy = rect ? rect.height / 2 : 300;
    setCamera((prev) => {
      const nextZoom = Math.min(3, Math.max(0.25, prev.zoom + delta));
      const ratio = nextZoom / prev.zoom;
      return {
        zoom: nextZoom,
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      };
    });
  }

  function resetView() {
    setCamera({ x: 0, y: 0, zoom: 1 });
  }

  function updateSelectedElement(
    updater: (el: WhiteboardElement) => WhiteboardElement
  ) {
    if (!selectedId) return;
    commitSnapshot({
      ...snapshotRef.current,
      elements: snapshotRef.current.elements.map((el) =>
        el.id === selectedId ? updater(el) : el
      ),
    });
  }

  function applyColorStroke(hex: string) {
    setStrokeColor(hex);
    if (selectedId) {
      updateSelectedElement((el) => ({ ...el, strokeColor: hex }));
    }
  }

  function applyFillColor(hex: string) {
    setFillColor(hex);
    if (selectedId) {
      updateSelectedElement((el) => ({ ...el, fillColor: hex }));
    }
  }

  function applyStrokeWidth(w: number) {
    setStrokeWidth(w);
    if (selectedId) {
      updateSelectedElement((el) => ({ ...el, strokeWidth: w }));
    }
  }

  function applyDash(nextDash: StrokeDash) {
    setDash(nextDash);
    if (selectedId) {
      updateSelectedElement((el) => ({ ...el, dash: nextDash }));
    }
  }

  function moveLayer(id: string, dir: "front" | "back") {
    const els = [...snapshotRef.current.elements];
    const idx = els.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const [item] = els.splice(idx, 1);
    if (dir === "front") {
      els.push(item);
    } else {
      els.unshift(item);
    }
    commitSnapshot({ ...snapshotRef.current, elements: els });
  }

  function handleClearBoard() {
    if (snapshot.elements.length === 0) return;
    if (!confirm("Effacer tout le contenu du tableau blanc ?")) return;
    commitSnapshot({
      ...snapshotRef.current,
      elements: [],
    });
    setSelectedId(null);
  }

  function handleImageUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) return;

      const img = new Image();
      img.onload = () => {
        const maxW = 460;
        const scale = img.width > maxW ? maxW / img.width : 1;
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);
        const rect = containerRef.current?.getBoundingClientRect();
        const cx = rect ? (rect.width / 2 - camera.x) / camera.zoom : 240;
        const cy = rect ? (rect.height / 2 - camera.y) / camera.zoom : 200;

        const id = makeId();
        const imageEl: ImageElement = {
          id,
          type: "image",
          x: Math.round(cx - width / 2),
          y: Math.round(cy - height / 2),
          width,
          height,
          dataUrl,
          caption: file.name.replace(/\.[^.]+$/, ""),
          strokeColor: "#1A1A1A",
          fillColor: "#FCFBF9",
          strokeWidth: 1.5,
          dash: "solid",
          opacity: 1,
          createdBy: userName,
        };
        commitSnapshot({
          ...snapshotRef.current,
          elements: [...snapshotRef.current.elements, imageEl],
        });
        setSelectedId(id);
        setTool("select");
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  function exportSvgString(): { svg: string; width: number; height: number } {
    const svgEl = svgRef.current;
    if (!svgEl || snapshot.elements.length === 0) {
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#FCFBF9"/></svg>`,
        width: 800,
        height: 600,
      };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const el of snapshot.elements) {
      const b = getElementBounds(el);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    }

    const pad = 48;
    const vx = Math.floor(minX - pad);
    const vy = Math.floor(minY - pad);
    const vw = Math.max(400, Math.ceil(maxX - minX + pad * 2));
    const vh = Math.max(300, Math.ceil(maxY - minY + pad * 2));

    const worldLayer = svgEl.querySelector("[data-world-layer='true']");
    const clone = worldLayer ? worldLayer.cloneNode(true) : null;
    const innerContent =
      clone instanceof Element
        ? clone.innerHTML
        : "";

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}">
  <defs>
    <marker id="wb-arrow-${whiteboardId}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M 1 1 L 11 6 L 1 11 z" fill="context-stroke" />
    </marker>
  </defs>
  <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#FCFBF9" />
  <g>${innerContent}</g>
</svg>`;
    return { svg, width: vw, height: vh };
  }

  function handleExportSvg() {
    const { svg } = exportSvgString();
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ara-tableau-${whiteboardId.slice(-6)}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportPng() {
    const { svg, width, height } = exportSvgString();
    const img = new Image();
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(4096, width * scale);
      canvas.height = Math.min(4096, height * scale);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#FCFBF9";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((pngBlob) => {
          if (!pngBlob) return;
          const pngUrl = URL.createObjectURL(pngBlob);
          const a = document.createElement("a");
          a.href = pngUrl;
          a.download = `ara-tableau-${whiteboardId.slice(-6)}.png`;
          a.click();
          URL.revokeObjectURL(pngUrl);
        }, "image/png");
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  const tools: Array<{
    id: ToolType;
    label: string;
    shortcut: string;
    icon: typeof Pen;
  }> = [
    { id: "select", label: "SÉLECTIONNER / DÉPLACER", shortcut: "V", icon: MousePointer2 },
    { id: "hand", label: "MAIN (PAN)", shortcut: "H", icon: Hand },
    { id: "pen", label: "STYLO", shortcut: "P", icon: Pen },
    { id: "highlighter", label: "SURLIGNEUR", shortcut: "M", icon: Highlighter },
    { id: "line", label: "LIGNE", shortcut: "L", icon: Minus },
    { id: "arrow", label: "FLÈCHE", shortcut: "A", icon: ArrowUpRight },
    { id: "rect", label: "RECTANGLE", shortcut: "R", icon: Square },
    { id: "ellipse", label: "ELLIPSE", shortcut: "O", icon: Circle },
    { id: "diamond", label: "LOSANGE", shortcut: "D", icon: Diamond },
    { id: "text", label: "TEXTE", shortcut: "T", icon: Type },
    { id: "sticky", label: "POST-IT", shortcut: "N", icon: StickyNote },
    { id: "callout", label: "LÉGENDE NUMÉROTÉE", shortcut: "C", icon: Tag },
    { id: "eraser", label: "GOMME", shortcut: "E", icon: Eraser },
  ];

  const editingElement = useMemo(
    () => snapshot.elements.find((el) => el.id === editingTextId) || null,
    [snapshot.elements, editingTextId]
  );

  const cursorCss =
    tool === "hand"
      ? "cursor-grab active:cursor-grabbing"
      : tool === "select"
      ? "cursor-default"
      : tool === "eraser"
      ? "cursor-cell"
      : "cursor-crosshair";

  return (
    <div className="flex h-full flex-col border border-border bg-card">
      {/* Row 1: Editorial Status, Presence & Paper / Export Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-stone">
            <span className="inline-block h-2 w-2 bg-forest" />
            <span>{saveStatus}</span>
          </div>

          <div className="hidden h-4 w-px bg-border sm:block" />

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
              ACTIFS ({collaborators.length}) :
            </span>
            {collaborators.map((member) => (
              <span
                key={member.socketId}
                className="inline-flex items-center gap-1 border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink"
              >
                <span
                  className="inline-block h-2 w-2"
                  style={{ backgroundColor: member.color }}
                />
                {member.userName}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Paper Style Switcher */}
          <button
            type="button"
            onClick={() => {
              const order: BoardBackground[] = ["DOTS", "GRID", "RULED", "PLAIN"];
              const nextBg =
                order[(order.indexOf(snapshot.background) + 1) % order.length];
              commitSnapshot({ ...snapshotRef.current, background: nextBg });
            }}
            className="inline-flex items-center gap-1 border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
            title="Changer le motif du papier"
          >
            <Grid3X3 className="h-3 w-3 text-stone" />
            <span>PAPIER : {BACKGROUND_LABELS[snapshot.background]}</span>
          </button>

          {/* Undo / Redo */}
          <div className="flex items-center border border-border bg-card">
            <button
              type="button"
              onClick={handleUndo}
              disabled={historyMeta.undo === 0}
              title="Annuler (Ctrl+Z)"
              className="border-r border-border p-1.5 text-ink hover:bg-pinned disabled:opacity-35"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={historyMeta.redo === 0}
              title="Rétablir (Ctrl+Y)"
              className="p-1.5 text-ink hover:bg-pinned disabled:opacity-35"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Zoom Controls */}
          <div className="flex items-center border border-border bg-card font-mono text-[10px]">
            <button
              type="button"
              onClick={() => adjustZoom(-0.15)}
              title="Dézoomer"
              className="border-r border-border px-2 py-1 text-ink hover:bg-pinned"
            >
              -
            </button>
            <span className="px-2 py-1 text-ink">
              {Math.round(camera.zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => adjustZoom(0.15)}
              title="Zoomer"
              className="border-l border-border px-2 py-1 text-ink hover:bg-pinned"
            >
              +
            </button>
            <button
              type="button"
              onClick={resetView}
              title="Recentrer la vue"
              className="border-l border-border p-1.5 text-stone hover:bg-pinned hover:text-ink"
            >
              <Focus className="h-3 w-3" />
            </button>
          </div>

          {/* Layers Toggle */}
          <button
            type="button"
            onClick={() => setShowLayers((prev) => !prev)}
            className={`inline-flex items-center gap-1 border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
              showLayers
                ? "border-ink bg-ink text-card"
                : "border-border bg-card text-ink hover:border-ink"
            }`}
          >
            <Layers className="h-3 w-3" />
            <span>CALQUES ({snapshot.elements.length})</span>
          </button>

          {/* Export */}
          <button
            type="button"
            onClick={handleExportSvg}
            className="inline-flex items-center gap-1 border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
            title="Télécharger en vectoriel .SVG"
          >
            <Download className="h-3 w-3" />
            <span>.SVG</span>
          </button>
          <button
            type="button"
            onClick={handleExportPng}
            className="inline-flex items-center gap-1 border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
            title="Télécharger en image .PNG"
          >
            <Download className="h-3 w-3" />
            <span>.PNG</span>
          </button>

          {/* Manual Save */}
          <button
            type="button"
            onClick={() => broadcastAndScheduleSave(snapshotRef.current, true)}
            className="inline-flex items-center gap-1 border border-ink bg-ink px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-card hover:bg-ink/90"
          >
            <Save className="h-3 w-3" />
            <span>SAUVER</span>
          </button>
        </div>
      </div>

      {/* Row 2: Custom Vector Properties Ribbon */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-pinned px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-3">
          {/* Stroke Palette */}
          <div className="flex items-center gap-1">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-stone">
              TRAIT :
            </span>
            {STROKE_COLORS.map((c) => {
              const active =
                (selectedElement?.strokeColor || strokeColor) === c.hex;
              return (
                <button
                  key={c.hex}
                  type="button"
                  onClick={() => applyColorStroke(c.hex)}
                  title={c.label}
                  className={`h-5 w-5 border ${
                    active
                      ? "border-ink ring-1 ring-ink ring-offset-1"
                      : "border-border"
                  }`}
                  style={{ backgroundColor: c.hex }}
                />
              );
            })}
          </div>

          <div className="h-4 w-px bg-border" />

          {/* Fill Palette */}
          <div className="flex items-center gap-1">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-stone">
              FOND :
            </span>
            {FILL_COLORS.map((c) => {
              const active =
                (selectedElement?.fillColor || fillColor) === c.hex;
              return (
                <button
                  key={c.hex}
                  type="button"
                  onClick={() => applyFillColor(c.hex)}
                  title={c.label}
                  className={`flex h-5 w-5 items-center justify-center border font-mono text-[9px] ${
                    active
                      ? "border-ink ring-1 ring-ink ring-offset-1"
                      : "border-border"
                  }`}
                  style={{
                    backgroundColor:
                      c.hex === "transparent" ? "#FCFBF9" : c.hex,
                  }}
                >
                  {c.hex === "transparent" ? "∅" : ""}
                </button>
              );
            })}
          </div>

          <div className="h-4 w-px bg-border" />

          {/* Stroke Width */}
          <div className="flex items-center gap-1">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-stone">
              ÉPAISSEUR :
            </span>
            {STROKE_WIDTHS.map((w) => {
              const active =
                (selectedElement?.strokeWidth ?? strokeWidth) === w;
              return (
                <button
                  key={w}
                  type="button"
                  onClick={() => applyStrokeWidth(w)}
                  className={`border px-1.5 py-0.5 font-mono text-[10px] ${
                    active
                      ? "border-ink bg-ink text-card"
                      : "border-border bg-card text-ink hover:border-ink"
                  }`}
                >
                  {w}
                </button>
              );
            })}
          </div>

          {/* Dash Style */}
          <div className="flex items-center gap-1">
            {(
              [
                { id: "solid", label: "───" },
                { id: "dashed", label: "- - -" },
                { id: "dotted", label: "···" },
              ] as const
            ).map((d) => {
              const active = (selectedElement?.dash ?? dash) === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => applyDash(d.id)}
                  className={`border px-1.5 py-0.5 font-mono text-[10px] ${
                    active
                      ? "border-ink bg-ink text-card"
                      : "border-border bg-card text-ink hover:border-ink"
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Object Contextual Actions */}
        <div className="flex items-center gap-1.5">
          {selectedElement ? (
            <>
              {(selectedElement.type === "rect" ||
                selectedElement.type === "ellipse" ||
                selectedElement.type === "diamond" ||
                selectedElement.type === "sticky" ||
                selectedElement.type === "text" ||
                selectedElement.type === "callout" ||
                selectedElement.type === "image") && (
                <button
                  type="button"
                  onClick={() => startInlineTextEdit(selectedElement)}
                  className="border border-ink bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-ink hover:text-card"
                >
                  ÉDITER TEXTE
                </button>
              )}
              <button
                type="button"
                onClick={() => moveLayer(selectedElement.id, "front")}
                title="Premier plan"
                className="border border-border bg-card p-1 text-ink hover:border-ink"
              >
                <ArrowUpFromLine className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => moveLayer(selectedElement.id, "back")}
                title="Arrière-plan"
                className="border border-border bg-card p-1 text-ink hover:border-ink"
              >
                <ArrowDownToLine className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={duplicateSelected}
                title="Dupliquer (Ctrl+D)"
                className="border border-border bg-card p-1 text-ink hover:border-ink"
              >
                <Copy className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => deleteElementById(selectedElement.id)}
                title="Supprimer (Suppr)"
                className="border border-carmine/40 bg-card p-1 text-carmine hover:bg-carmine hover:text-card"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleClearBoard}
              disabled={snapshot.elements.length === 0}
              className="border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone hover:border-carmine hover:text-carmine disabled:opacity-40"
            >
              TOUT EFFACER
            </button>
          )}
        </div>
      </div>

      {/* Main Workspace: Left Technical Tool Strip + Vector Canvas + Optional Layers Panel */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Left Vertical Tool Rail */}
        <aside className="z-20 flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-paper py-2">
          {tools.map((item) => {
            const Icon = item.icon;
            const active = tool === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTool(item.id)}
                title={`${item.label} (${item.shortcut})`}
                className={`relative flex h-9 w-9 items-center justify-center border transition-colors ${
                  active
                    ? "border-ink bg-ink text-card"
                    : "border-transparent bg-transparent text-ink hover:border-border hover:bg-card"
                }`}
              >
                <Icon className="h-4 w-4" />
                <span
                  className={`absolute bottom-0.5 right-0.5 font-mono text-[7px] ${
                    active ? "text-card/75" : "text-stone"
                  }`}
                >
                  {item.shortcut}
                </span>
              </button>
            );
          })}

          <div className="my-1 h-px w-7 bg-border" />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="IMPORTER UNE IMAGE (SCHÉMA / RADIO)"
            className="flex h-9 w-9 items-center justify-center border border-transparent text-ink hover:border-border hover:bg-card"
          >
            <ImageIcon className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            className="hidden"
          />
        </aside>

        {/* Infinite Vector Canvas */}
        <div
          ref={containerRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onWheel={handleWheel}
          onDoubleClick={(e) => {
            const world = clientToWorld(e.clientX, e.clientY);
            const hit = [...snapshotRef.current.elements]
              .reverse()
              .find((el) => hitTestElement(el, world.x, world.y, 12));
            if (hit) {
              setSelectedId(hit.id);
              startInlineTextEdit(hit);
            }
          }}
          className={`relative flex-1 touch-none select-none overflow-hidden bg-card ${cursorCss}`}
        >
          <svg
            ref={svgRef}
            className="h-full w-full"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              {/* Repeating Swiss Grid / Dot / Ruled Patterns synchronized with Camera */}
              <pattern
                id={`wb-dots-${whiteboardId}`}
                x={camera.x}
                y={camera.y}
                width={24 * camera.zoom}
                height={24 * camera.zoom}
                patternUnits="userSpaceOnUse"
              >
                <circle
                  cx={12 * camera.zoom}
                  cy={12 * camera.zoom}
                  r={Math.max(0.8, 1.1 * camera.zoom)}
                  fill="#DCDAD3"
                />
              </pattern>

              <pattern
                id={`wb-grid-${whiteboardId}`}
                x={camera.x}
                y={camera.y}
                width={32 * camera.zoom}
                height={32 * camera.zoom}
                patternUnits="userSpaceOnUse"
              >
                <path
                  d={`M ${32 * camera.zoom} 0 L 0 0 0 ${32 * camera.zoom}`}
                  fill="none"
                  stroke="#EBE9E2"
                  strokeWidth={1}
                />
              </pattern>

              <pattern
                id={`wb-ruled-${whiteboardId}`}
                x={0}
                y={camera.y}
                width="100%"
                height={32 * camera.zoom}
                patternUnits="userSpaceOnUse"
              >
                <line
                  x1="0"
                  y1={32 * camera.zoom}
                  x2="100%"
                  y2={32 * camera.zoom}
                  stroke="#E5E3DC"
                  strokeWidth={1}
                />
              </pattern>

              <marker
                id={`wb-arrow-${whiteboardId}`}
                viewBox="0 0 12 12"
                refX="10"
                refY="6"
                markerWidth="6.5"
                markerHeight="6.5"
                orient="auto-start-reverse"
              >
                <path d="M 1 1 L 11 6 L 1 11 z" fill="context-stroke" />
              </marker>
            </defs>

            {/* Paper Surface Background */}
            <rect width="100%" height="100%" fill="#FCFBF9" />
            {snapshot.background === "DOTS" && (
              <rect
                width="100%"
                height="100%"
                fill={`url(#wb-dots-${whiteboardId})`}
              />
            )}
            {snapshot.background === "GRID" && (
              <rect
                width="100%"
                height="100%"
                fill={`url(#wb-grid-${whiteboardId})`}
              />
            )}
            {snapshot.background === "RULED" && (
              <rect
                width="100%"
                height="100%"
                fill={`url(#wb-ruled-${whiteboardId})`}
              />
            )}

            {/* Transformed Vector World Layer */}
            <g
              data-world-layer="true"
              transform={`translate(${camera.x}, ${camera.y}) scale(${camera.zoom})`}
            >
              {snapshot.elements.map((el) => {
                const dashArray = getDashArray(el.dash, el.strokeWidth);

                if (el.type === "pen" || el.type === "highlighter") {
                  return (
                    <path
                      key={el.id}
                      d={pointsToSmoothPath(el.points)}
                      fill="none"
                      stroke={el.strokeColor}
                      strokeWidth={el.strokeWidth}
                      strokeDasharray={dashArray}
                      strokeLinecap={
                        el.type === "highlighter" ? "square" : "round"
                      }
                      strokeLinejoin="round"
                      opacity={el.opacity}
                    />
                  );
                }

                if (el.type === "line" || el.type === "arrow") {
                  return (
                    <line
                      key={el.id}
                      x1={el.x1}
                      y1={el.y1}
                      x2={el.x2}
                      y2={el.y2}
                      stroke={el.strokeColor}
                      strokeWidth={el.strokeWidth}
                      strokeDasharray={dashArray}
                      strokeLinecap="square"
                      markerEnd={
                        el.type === "arrow"
                          ? `url(#wb-arrow-${whiteboardId})`
                          : undefined
                      }
                    />
                  );
                }

                if (el.type === "rect") {
                  return (
                    <g key={el.id}>
                      <rect
                        x={el.x}
                        y={el.y}
                        width={el.width}
                        height={el.height}
                        fill={el.fillColor}
                        stroke={el.strokeColor}
                        strokeWidth={el.strokeWidth}
                        strokeDasharray={dashArray}
                      />
                      {el.text && (
                        <foreignObject
                          x={el.x + 8}
                          y={el.y + 8}
                          width={Math.max(10, el.width - 16)}
                          height={Math.max(10, el.height - 16)}
                        >
                          <div className="flex h-full w-full items-center justify-center whitespace-pre-wrap break-words text-center text-xs font-medium text-ink">
                            {el.text}
                          </div>
                        </foreignObject>
                      )}
                    </g>
                  );
                }

                if (el.type === "ellipse") {
                  return (
                    <g key={el.id}>
                      <ellipse
                        cx={el.x + el.width / 2}
                        cy={el.y + el.height / 2}
                        rx={el.width / 2}
                        ry={el.height / 2}
                        fill={el.fillColor}
                        stroke={el.strokeColor}
                        strokeWidth={el.strokeWidth}
                        strokeDasharray={dashArray}
                      />
                      {el.text && (
                        <foreignObject
                          x={el.x + 12}
                          y={el.y + 12}
                          width={Math.max(10, el.width - 24)}
                          height={Math.max(10, el.height - 24)}
                        >
                          <div className="flex h-full w-full items-center justify-center whitespace-pre-wrap break-words text-center text-xs font-medium text-ink">
                            {el.text}
                          </div>
                        </foreignObject>
                      )}
                    </g>
                  );
                }

                if (el.type === "diamond") {
                  const mx = el.x + el.width / 2;
                  const my = el.y + el.height / 2;
                  const pts = `${mx},${el.y} ${el.x + el.width},${my} ${mx},${
                    el.y + el.height
                  } ${el.x},${my}`;
                  return (
                    <g key={el.id}>
                      <polygon
                        points={pts}
                        fill={el.fillColor}
                        stroke={el.strokeColor}
                        strokeWidth={el.strokeWidth}
                        strokeDasharray={dashArray}
                      />
                      {el.text && (
                        <foreignObject
                          x={el.x + el.width * 0.2}
                          y={el.y + el.height * 0.2}
                          width={Math.max(10, el.width * 0.6)}
                          height={Math.max(10, el.height * 0.6)}
                        >
                          <div className="flex h-full w-full items-center justify-center whitespace-pre-wrap break-words text-center text-xs font-medium text-ink">
                            {el.text}
                          </div>
                        </foreignObject>
                      )}
                    </g>
                  );
                }

                if (el.type === "sticky") {
                  return (
                    <g key={el.id}>
                      <rect
                        x={el.x}
                        y={el.y}
                        width={el.width}
                        height={el.height}
                        fill={
                          el.fillColor === "transparent"
                            ? "#FDF3DF"
                            : el.fillColor
                        }
                        stroke={el.strokeColor}
                        strokeWidth={1.5}
                      />
                      <rect
                        x={el.x}
                        y={el.y}
                        width={el.width}
                        height={6}
                        fill={el.strokeColor}
                      />
                      <foreignObject
                        x={el.x + 10}
                        y={el.y + 12}
                        width={Math.max(10, el.width - 20)}
                        height={Math.max(10, el.height - 20)}
                      >
                        <div className="h-full w-full whitespace-pre-wrap break-words text-xs leading-relaxed text-ink">
                          {el.text || "Double-clic pour noter..."}
                        </div>
                      </foreignObject>
                    </g>
                  );
                }

                if (el.type === "text") {
                  const lines = (el.text || "Texte").split("\n");
                  return (
                    <text
                      key={el.id}
                      x={el.x}
                      y={el.y + el.fontSize}
                      fill={el.strokeColor}
                      fontSize={el.fontSize}
                      fontFamily="Inter, sans-serif"
                      fontWeight={600}
                    >
                      {lines.map((line, i) => (
                        <tspan
                          key={i}
                          x={el.x}
                          dy={i === 0 ? 0 : el.fontSize * 1.25}
                        >
                          {line || " "}
                        </tspan>
                      ))}
                    </text>
                  );
                }

                if (el.type === "callout") {
                  return (
                    <g key={el.id}>
                      <line
                        x1={el.x}
                        y1={el.y}
                        x2={el.targetX}
                        y2={el.targetY}
                        stroke={el.strokeColor}
                        strokeWidth={2}
                      />
                      <circle
                        cx={el.targetX}
                        cy={el.targetY}
                        r={4}
                        fill={el.strokeColor}
                      />
                      <rect
                        x={el.x - 13}
                        y={el.y - 13}
                        width={26}
                        height={26}
                        fill={el.strokeColor}
                      />
                      <text
                        x={el.x}
                        y={el.y + 4}
                        textAnchor="middle"
                        fill="#FCFBF9"
                        fontSize={12}
                        fontFamily="JetBrains Mono, monospace"
                        fontWeight={700}
                      >
                        {el.number}
                      </text>
                      {el.label && (
                        <g transform={`translate(${el.x + 17}, ${el.y - 13})`}>
                          <rect
                            x={0}
                            y={0}
                            width={Math.max(60, el.label.length * 7.6 + 16)}
                            height={26}
                            fill="#FCFBF9"
                            stroke={el.strokeColor}
                            strokeWidth={1.5}
                          />
                          <text
                            x={8}
                            y={17}
                            fill="#1A1A1A"
                            fontSize={11}
                            fontFamily="JetBrains Mono, monospace"
                            fontWeight={600}
                          >
                            {el.label}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                }

                if (el.type === "image") {
                  return (
                    <g key={el.id}>
                      <image
                        href={el.dataUrl}
                        x={el.x}
                        y={el.y}
                        width={el.width}
                        height={el.height}
                        preserveAspectRatio="none"
                      />
                      <rect
                        x={el.x}
                        y={el.y}
                        width={el.width}
                        height={el.height}
                        fill="none"
                        stroke={el.strokeColor}
                        strokeWidth={1.5}
                      />
                      {el.caption && (
                        <text
                          x={el.x}
                          y={el.y + el.height + 16}
                          fill="#6E6D68"
                          fontSize={11}
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {el.caption.toUpperCase()}
                        </text>
                      )}
                    </g>
                  );
                }

                return null;
              })}
            </g>

            {/* Selection Box & Handles Overlay (Non-Exported UI Layer) */}
            <g
              transform={`translate(${camera.x}, ${camera.y}) scale(${camera.zoom})`}
            >
              {selectedElement && (() => {
                if (
                  selectedElement.type === "rect" ||
                  selectedElement.type === "ellipse" ||
                  selectedElement.type === "diamond" ||
                  selectedElement.type === "sticky" ||
                  selectedElement.type === "image"
                ) {
                  const hs = 8 / camera.zoom;
                  const corners = [
                    { x: selectedElement.x, y: selectedElement.y },
                    {
                      x: selectedElement.x + selectedElement.width,
                      y: selectedElement.y,
                    },
                    {
                      x: selectedElement.x,
                      y: selectedElement.y + selectedElement.height,
                    },
                    {
                      x: selectedElement.x + selectedElement.width,
                      y: selectedElement.y + selectedElement.height,
                    },
                  ];
                  return (
                    <g pointerEvents="none">
                      <rect
                        x={selectedElement.x - 4 / camera.zoom}
                        y={selectedElement.y - 4 / camera.zoom}
                        width={selectedElement.width + 8 / camera.zoom}
                        height={selectedElement.height + 8 / camera.zoom}
                        fill="none"
                        stroke="#3D6B99"
                        strokeWidth={1.5 / camera.zoom}
                        strokeDasharray={`${4 / camera.zoom} ${3 / camera.zoom}`}
                      />
                      {corners.map((c, idx) => (
                        <rect
                          key={idx}
                          x={c.x - hs / 2}
                          y={c.y - hs / 2}
                          width={hs}
                          height={hs}
                          fill="#FCFBF9"
                          stroke="#3D6B99"
                          strokeWidth={1.5 / camera.zoom}
                        />
                      ))}
                    </g>
                  );
                }

                if (
                  selectedElement.type === "line" ||
                  selectedElement.type === "arrow"
                ) {
                  const hs = 9 / camera.zoom;
                  return (
                    <g pointerEvents="none">
                      <rect
                        x={selectedElement.x1 - hs / 2}
                        y={selectedElement.y1 - hs / 2}
                        width={hs}
                        height={hs}
                        fill="#FCFBF9"
                        stroke="#3D6B99"
                        strokeWidth={1.5 / camera.zoom}
                      />
                      <rect
                        x={selectedElement.x2 - hs / 2}
                        y={selectedElement.y2 - hs / 2}
                        width={hs}
                        height={hs}
                        fill="#FCFBF9"
                        stroke="#3D6B99"
                        strokeWidth={1.5 / camera.zoom}
                      />
                    </g>
                  );
                }

                if (selectedElement.type === "callout") {
                  const hs = 9 / camera.zoom;
                  return (
                    <g pointerEvents="none">
                      <rect
                        x={selectedElement.targetX - hs / 2}
                        y={selectedElement.targetY - hs / 2}
                        width={hs}
                        height={hs}
                        fill="#D99B26"
                        stroke="#1A1A1A"
                        strokeWidth={1.5 / camera.zoom}
                      />
                    </g>
                  );
                }

                const b = getElementBounds(selectedElement);
                return (
                  <rect
                    x={b.x - 5 / camera.zoom}
                    y={b.y - 5 / camera.zoom}
                    width={b.width + 10 / camera.zoom}
                    height={b.height + 10 / camera.zoom}
                    fill="none"
                    stroke="#3D6B99"
                    strokeWidth={1.5 / camera.zoom}
                    strokeDasharray={`${4 / camera.zoom} ${3 / camera.zoom}`}
                    pointerEvents="none"
                  />
                );
              })()}
            </g>
          </svg>

          {/* Inline Text / Label Editor Overlay */}
          {editingElement && (() => {
            const b = getElementBounds(editingElement);
            const left =
              editingElement.type === "callout"
                ? (editingElement.x + 17) * camera.zoom + camera.x
                : b.x * camera.zoom + camera.x;
            const top =
              editingElement.type === "callout"
                ? (editingElement.y - 16) * camera.zoom + camera.y
                : editingElement.type === "image"
                ? (editingElement.y + editingElement.height + 4) * camera.zoom +
                  camera.y
                : b.y * camera.zoom + camera.y;
            const width =
              editingElement.type === "callout" || editingElement.type === "image"
                ? 220
                : Math.max(170, b.width * camera.zoom);
            const height =
              editingElement.type === "callout" || editingElement.type === "image"
                ? 36
                : Math.max(46, b.height * camera.zoom);

            return (
              <div
                className="absolute z-40"
                style={{ left, top, width }}
                onPointerDown={(ev) => ev.stopPropagation()}
              >
                <textarea
                  autoFocus
                  value={draftText}
                  onChange={(ev) => setDraftText(ev.target.value)}
                  onBlur={() => finishInlineTextEdit(true)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Escape") {
                      finishInlineTextEdit(false);
                    } else if (ev.key === "Enter" && !ev.shiftKey) {
                      ev.preventDefault();
                      finishInlineTextEdit(true);
                    }
                  }}
                  style={{ height }}
                  placeholder={
                    editingElement.type === "callout"
                      ? "Nom de la structure anatomique..."
                      : editingElement.type === "image"
                      ? "Légende de la figure..."
                      : "Taper du texte (Entrée pour valider)..."
                  }
                  className="w-full resize-none border-2 border-ink bg-card p-2 font-sans text-xs text-ink focus:outline-none"
                />
              </div>
            );
          })()}

          {/* Empty State Hint */}
          {snapshot.elements.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className="border border-border bg-paper/95 px-6 py-4 text-center">
                <p className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
                  ATELIER VECTORIEL COLLABORATIF ARA
                </p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-stone">
                  DESSINEZ AU STYLO, AJOUTEZ DES POST-ITS, REPÈRES NUMÉROTÉS OU IMAGES · DOUBLE-CLIC POUR ÉDITER UN TEXTE
                </p>
              </div>
            </div>
          )}

          {/* Live Remote Cursors Overlay in World Space */}
          <div
            className="pointer-events-none absolute left-0 top-0 z-30"
            style={{
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {Object.values(remoteCursors).map((cursor) => (
              <div
                key={cursor.socketId}
                className="absolute transition-transform duration-75"
                style={{
                  transform: `translate(${cursor.x}px, ${cursor.y}px) scale(${
                    1 / camera.zoom
                  })`,
                  transformOrigin: "0 0",
                }}
              >
                <div
                  className="h-3 w-3 border border-card"
                  style={{ backgroundColor: cursor.color }}
                />
                <span
                  className="mt-0.5 inline-block whitespace-nowrap px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-card"
                  style={{ backgroundColor: cursor.color }}
                >
                  {cursor.userName}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Toggleable Layers Side Panel */}
        {showLayers && (
          <aside className="z-20 flex w-64 shrink-0 flex-col border-l border-border bg-paper">
            <div className="border-b border-border bg-card px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
              CALQUES VECTORIELS ({snapshot.elements.length})
            </div>
            <div className="flex-1 divide-y divide-border overflow-y-auto">
              {snapshot.elements.length === 0 ? (
                <div className="p-4 font-mono text-[10px] uppercase tracking-wider text-stone">
                  AUCUN ÉLÉMENT SUR LE TABLEAU.
                </div>
              ) : (
                [...snapshot.elements].reverse().map((el) => {
                  const active = el.id === selectedId;
                  return (
                    <div
                      key={el.id}
                      onClick={() => {
                        setSelectedId(el.id);
                        setTool("select");
                      }}
                      className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 ${
                        active ? "bg-pinned" : "bg-card hover:bg-paper"
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 border border-border"
                          style={{ backgroundColor: el.strokeColor }}
                        />
                        <span className="truncate font-mono text-[10px] uppercase tracking-wider text-ink">
                          {getLayerLabel(el)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          deleteElementById(el.id);
                        }}
                        className="text-stone hover:text-carmine"
                        title="Supprimer ce calque"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Bottom Technical Shortcut Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-paper px-3 py-1 font-mono text-[9px] uppercase tracking-wider text-stone">
        <span>
          OUTIL ACTIF : {tools.find((t) => t.id === tool)?.label || "IMAGE"} · MOLETTE: DÉPLACER · CTRL+MOLETTE: ZOOMER · DOUBLE-CLIC: ÉDITER TEXTE
        </span>
        <span>
          RACCOURCIS : [V] SÉLECTION · [H] MAIN · [P] STYLO · [A] FLÈCHE · [R] RECT · [N] POST-IT · [C] LÉGENDE · [CTRL+Z] ANNULER
        </span>
      </div>
    </div>
  );
}
