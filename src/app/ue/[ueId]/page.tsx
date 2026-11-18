"use client";

import dynamic from "next/dynamic";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Globe,
  Layers,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  PenTool,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Timer,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useSpix } from "@/components/SpixContext";
import { UEDiscussionPanel } from "@/components/UEDiscussionPanel";
import { NotebookStudioPanel } from "@/components/NotebookStudioPanel";
import { CommunityQuizSection } from "@/components/CommunityQuizSection";
import { MockExamPanel } from "@/components/MockExamPanel";
import { formatExamBadge, type ClassLevel } from "@/lib/class-levels";

const CustomPdfReader = dynamic(
  () =>
    import("@/components/CustomPdfReader").then((mod) => mod.CustomPdfReader),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[560px] items-center justify-center border border-ink bg-card font-mono text-xs uppercase tracking-wider text-stone">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        <span>INITIALISATION DU LECTEUR PDF...</span>
      </div>
    ),
  }
);

interface DocItem {
  id: string;
  chapterId: string;
  authorId: string;
  author: {
    id: string;
    name: string;
    email: string;
    globalRole: string;
  };
  title: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  category: "OFFICIAL_COURSE" | "STUDENT_NOTE";
  isPinned: boolean;
  isIndexed: boolean;
  pageCount: number;
  createdAt: string;
  upvoteCount: number;
  hasUpvoted: boolean;
}

interface ChapterItem {
  id: string;
  ueId: string;
  title: string;
  theme?: string;
  parentId?: string | null;
  order: number;
  documents: DocItem[];
}

interface ChapterTreeNode {
  chapter: ChapterItem;
  children: ChapterTreeNode[];
  depth: number;
  totalDocsCount: number;
}

interface ThemeGroup {
  key: string;
  label: string;
  isDefaultGeneral: boolean;
  nodes: ChapterTreeNode[];
  totalDocsCount: number;
  chapterCount: number;
}

const GENERAL_THEME_KEY = "__GENERAL__";

interface UEWhiteboardItem {
  id: string;
  title: string;
  creatorId: string;
  isPublic: boolean;
  isIntegrated: boolean;
  updatedAt: string;
  creator: { id: string; name: string };
}

interface UEDetail {
  id: string;
  code: string;
  title: string;
  description: string;
  semester: string;
  classLevel?: ClassLevel;
  examType?: string;
  examDate?: string | null;
  coeff?: number;
  accentColor: string;
  roles: Array<{
    id: string;
    user: { id: string; name: string; email: string };
  }>;
  chapters: ChapterItem[];
  channels: Array<{ id: string; name: string; type: string }>;
  whiteboards: UEWhiteboardItem[];
}

type UETab = "courses" | "discussion" | "whiteboards" | "studio" | "exam";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

function UEWorkspaceContent() {
  const params = useParams<{ ueId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session } = useSession();
  const { setPageContext, registerDocNavigator } = useSpix();

  const ueId = params.ueId;
  const initialDocParam = searchParams.get("doc");
  const initialPageParam = Number.parseInt(searchParams.get("page") || "1", 10);
  const tabParam = searchParams.get("tab");

  const [ue, setUe] = useState<UEDetail | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<UETab>(
    tabParam === "discussion"
      ? "discussion"
      : tabParam === "whiteboards"
      ? "whiteboards"
      : tabParam === "studio"
      ? "studio"
      : tabParam === "exam"
      ? "exam"
      : "courses"
  );

  const [selectedChapterId, setSelectedChapterId] = useState<string>("ALL");
  const [validatedOnly, setValidatedOnly] = useState(false);
  const [courseViewMode, setCourseViewMode] = useState<"tree" | "category">(
    "tree"
  );
  const [expandedThemes, setExpandedThemes] = useState<Record<string, boolean>>(
    {}
  );
  const [expandedChapters, setExpandedChapters] = useState<
    Record<string, boolean>
  >({});

  const [activeDoc, setActiveDoc] = useState<DocItem | null>(null);
  const [activePage, setActivePage] = useState<number>(1);
  const [activeTotalPages, setActiveTotalPages] = useState<number>(1);
  const [capturedQuizSeed, setCapturedQuizSeed] = useState<{
    id: string;
    imageDataUrl: string;
    title: string;
  } | null>(null);

  // Chapter form & inline edit
  const [newChapterTheme, setNewChapterTheme] = useState("");
  const [newChapterParentId, setNewChapterParentId] = useState("");
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [creatingChapter, setCreatingChapter] = useState(false);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editChapterTitle, setEditChapterTitle] = useState("");
  const [editChapterTheme, setEditChapterTheme] = useState("");
  const [editChapterParentId, setEditChapterParentId] = useState("");
  const [savingChapterEdit, setSavingChapterEdit] = useState(false);

  // Upload form
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadChapterId, setUploadChapterId] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadCategory, setUploadCategory] = useState<
    "OFFICIAL_COURSE" | "STUDENT_NOTE"
  >("STUDENT_NOTE");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [autoGenerateOnUpload, setAutoGenerateOnUpload] = useState<boolean>(true);
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<string | null>(null);
  const [lastGeneratedPack, setLastGeneratedPack] = useState<{
    docTitle: string;
    docId: string;
    items: Array<{ id: string; kind: string; title: string }>;
  } | null>(null);
  const [studioFocusDocId, setStudioFocusDocId] = useState<string | null>(null);

  // Create UE Whiteboard form
  const [wbTitle, setWbTitle] = useState("");
  const [wbPublic, setWbPublic] = useState(false);
  const [creatingWb, setCreatingWb] = useState(false);

  useEffect(() => {
    if (
      tabParam === "discussion" ||
      tabParam === "whiteboards" ||
      tabParam === "studio" ||
      tabParam === "exam" ||
      tabParam === "courses"
    ) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  const fetchUE = useCallback(async () => {
    try {
      const res = await fetch(`/api/ues/${ueId}`, { cache: "no-store" });
      if (!res.ok) {
        setError("Impossible de charger cette UE.");
        return;
      }
      const data = (await res.json()) as { ue: UEDetail; canManage: boolean };
      setUe(data.ue);
      setCanManage(data.canManage);
      setUploadChapterId((prev) => prev || data.ue.chapters[0]?.id || "");
    } catch {
      setError("Erreur réseau lors du chargement de l'UE.");
    } finally {
      setLoading(false);
    }
  }, [ueId]);

  useEffect(() => {
    void fetchUE();
  }, [fetchUE]);

  // Open doc from URL query params (?doc=...&page=...)
  useEffect(() => {
    if (!ue || !initialDocParam) return;
    const allDocs = ue.chapters.flatMap((c) => c.documents);
    const match = allDocs.find((d) => d.id === initialDocParam);
    if (match) {
      setActiveTab("courses");
      setActiveDoc(match);
      setActivePage(
        Number.isFinite(initialPageParam) && initialPageParam > 0
          ? initialPageParam
          : 1
      );
      setActiveTotalPages(match.pageCount);
    }
  }, [ue, initialDocParam, initialPageParam]);

  // Synchronize Spix Context automatically with UE or active PDF + page
  useEffect(() => {
    if (!ue) return;

    if (activeTab === "courses" && activeDoc) {
      setPageContext({
        mode: "DOCUMENT",
        ueId: ue.id,
        ueCode: ue.code,
        ueTitle: ue.title,
        ueAccentColor: ue.accentColor,
        documentId: activeDoc.id,
        documentTitle: activeDoc.title,
        fileName: activeDoc.fileName,
        currentPage: activePage,
        pageCount: activeTotalPages || activeDoc.pageCount,
      });
    } else {
      setPageContext({
        mode: "UE",
        ueId: ue.id,
        ueCode: ue.code,
        ueTitle: ue.title,
        ueAccentColor: ue.accentColor,
      });
    }
  }, [ue, activeTab, activeDoc, activePage, activeTotalPages, setPageContext]);

  useEffect(() => {
    return () => {
      setPageContext({ mode: "GLOBAL" });
    };
  }, [setPageContext]);

  // Register in-place navigator so clicking a Spix citation opens/jumps the CustomPdfReader
  useEffect(() => {
    if (!ue) return;
    registerDocNavigator((docId, pageNum, targetUeId) => {
      if (targetUeId !== ue.id) return false;
      const allDocs = ue.chapters.flatMap((c) => c.documents);
      const found = allDocs.find((d) => d.id === docId);
      if (!found) return false;
      setActiveTab("courses");
      setActiveDoc(found);
      setActivePage(pageNum);
      setActiveTotalPages(found.pageCount);
      return true;
    });

    return () => {
      registerDocNavigator(null);
    };
  }, [ue, registerDocNavigator]);

  const handleReaderPageChange = useCallback(
    (page: number, total: number) => {
      setActivePage(page);
      setActiveTotalPages(total);
    },
    []
  );

  const allUeDocuments = useMemo(() => {
    if (!ue) return [];
    return ue.chapters.flatMap((c) => c.documents);
  }, [ue]);

  const {
    themeGroups,
    flatChapters,
    existingThemes,
    chapterMap,
    chapterSubtreeMap,
  } = useMemo(() => {
    const map = new Map<string, ChapterItem>();
    const childrenMap = new Map<string, ChapterItem[]>();
    const subtreeMap = new Map<string, Set<string>>();

    if (!ue) {
      return {
        themeGroups: [] as ThemeGroup[],
        flatChapters: [] as Array<{ chapter: ChapterItem; depth: number; themeLabel: string }>,
        existingThemes: [] as string[],
        chapterMap: map,
        chapterSubtreeMap: subtreeMap,
      };
    }

    for (const ch of ue.chapters) {
      map.set(ch.id, ch);
    }

    const roots: ChapterItem[] = [];
    for (const ch of ue.chapters) {
      const pid = ch.parentId && ch.parentId !== ch.id ? ch.parentId : null;
      if (pid && map.has(pid)) {
        const arr = childrenMap.get(pid) || [];
        arr.push(ch);
        childrenMap.set(pid, arr);
      } else {
        roots.push(ch);
      }
    }

    const buildNode = (
      chapter: ChapterItem,
      depth: number,
      seen: Set<string>
    ): ChapterTreeNode => {
      const nextSeen = new Set(seen);
      nextSeen.add(chapter.id);
      const rawChildren = (childrenMap.get(chapter.id) || []).filter(
        (c) => !nextSeen.has(c.id)
      );
      const childNodes =
        depth < 4 ? rawChildren.map((c) => buildNode(c, depth + 1, nextSeen)) : [];
      const totalDocsCount =
        chapter.documents.length +
        childNodes.reduce((sum, child) => sum + child.totalDocsCount, 0);

      const ids = new Set<string>([chapter.id]);
      for (const child of childNodes) {
        const sub = subtreeMap.get(child.chapter.id);
        if (sub) {
          sub.forEach((id) => ids.add(id));
        } else {
          ids.add(child.chapter.id);
        }
      }
      subtreeMap.set(chapter.id, ids);

      return { chapter, children: childNodes, depth, totalDocsCount };
    };

    const hasNamedThemes = ue.chapters.some(
      (c) => (c.theme || "").trim().length > 0
    );
    const themeOrder: string[] = [];
    const groupedNodes = new Map<string, ChapterTreeNode[]>();

    for (const root of roots) {
      const themeName = (root.theme || "").trim();
      const key = themeName || GENERAL_THEME_KEY;
      if (!groupedNodes.has(key)) {
        groupedNodes.set(key, []);
        themeOrder.push(key);
      }
      groupedNodes.get(key)!.push(buildNode(root, 0, new Set()));
    }

    const countTreeChapters = (nodes: ChapterTreeNode[]): number =>
      nodes.reduce((sum, n) => sum + 1 + countTreeChapters(n.children), 0);

    const groups: ThemeGroup[] = themeOrder.map((key) => {
      const nodes = groupedNodes.get(key) || [];
      const isDefaultGeneral = key === GENERAL_THEME_KEY;
      const label = isDefaultGeneral
        ? hasNamedThemes
          ? "GÉNÉRAL / TRONC COMMUN"
          : "DOSSIERS & CHAPITRES"
        : key;
      return {
        key,
        label,
        isDefaultGeneral,
        nodes,
        totalDocsCount: nodes.reduce((sum, n) => sum + n.totalDocsCount, 0),
        chapterCount: countTreeChapters(nodes),
      };
    });

    const flat: Array<{ chapter: ChapterItem; depth: number; themeLabel: string }> = [];
    const walkFlat = (node: ChapterTreeNode, themeLabel: string) => {
      flat.push({ chapter: node.chapter, depth: node.depth, themeLabel });
      for (const child of node.children) {
        walkFlat(child, themeLabel);
      }
    };
    for (const g of groups) {
      for (const node of g.nodes) {
        walkFlat(node, g.label);
      }
    }

    const themes = Array.from(
      new Set(
        ue.chapters
          .map((c) => (c.theme || "").trim())
          .filter((t) => t.length > 0)
      )
    );

    return {
      themeGroups: groups,
      flatChapters: flat,
      existingThemes: themes,
      chapterMap: map,
      chapterSubtreeMap: subtreeMap,
    };
  }, [ue]);

  const visibleDocuments = useMemo(() => {
    if (!ue) return [];
    if (selectedChapterId === "ALL") {
      return allUeDocuments;
    }
    if (selectedChapterId.startsWith("THEME:")) {
      const targetThemeKey = selectedChapterId.slice("THEME:".length);
      const group = themeGroups.find((g) => g.key === targetThemeKey);
      if (!group) return [];
      const allowedIds = new Set<string>();
      for (const rootNode of group.nodes) {
        const sub = chapterSubtreeMap.get(rootNode.chapter.id);
        if (sub) sub.forEach((id) => allowedIds.add(id));
      }
      return ue.chapters
        .filter((c) => allowedIds.has(c.id))
        .flatMap((c) => c.documents);
    }
    const subIds =
      chapterSubtreeMap.get(selectedChapterId) || new Set([selectedChapterId]);
    return ue.chapters
      .filter((c) => subIds.has(c.id))
      .flatMap((c) => c.documents);
  }, [ue, selectedChapterId, allUeDocuments, themeGroups, chapterSubtreeMap]);

  const visibleChapterIds = useMemo(() => {
    if (!ue) return new Set<string>();
    if (selectedChapterId === "ALL") {
      return new Set(ue.chapters.map((c) => c.id));
    }
    if (selectedChapterId.startsWith("THEME:")) {
      const targetThemeKey = selectedChapterId.slice("THEME:".length);
      const group = themeGroups.find((g) => g.key === targetThemeKey);
      const ids = new Set<string>();
      if (group) {
        for (const rootNode of group.nodes) {
          const sub = chapterSubtreeMap.get(rootNode.chapter.id);
          if (sub) sub.forEach((id) => ids.add(id));
        }
      }
      return ids;
    }
    return chapterSubtreeMap.get(selectedChapterId) || new Set([selectedChapterId]);
  }, [ue, selectedChapterId, themeGroups, chapterSubtreeMap]);

  const activeBreadcrumb = useMemo(() => {
    if (!ue) return [];
    const crumbs: Array<{ label: string; target: string }> = [
      { label: ue.code, target: "ALL" },
    ];
    if (selectedChapterId === "ALL") {
      crumbs.push({ label: "Toute l'arborescence", target: "ALL" });
      return crumbs;
    }
    if (selectedChapterId.startsWith("THEME:")) {
      const key = selectedChapterId.slice("THEME:".length);
      const grp = themeGroups.find((g) => g.key === key);
      crumbs.push({
        label: grp?.label || "Thème",
        target: selectedChapterId,
      });
      return crumbs;
    }
    const ch = chapterMap.get(selectedChapterId);
    if (ch) {
      const themeKey = (ch.theme || "").trim() || GENERAL_THEME_KEY;
      const grp = themeGroups.find((g) => g.key === themeKey);
      if (grp) {
        crumbs.push({ label: grp.label, target: `THEME:${grp.key}` });
      }
      if (ch.parentId && chapterMap.has(ch.parentId)) {
        const parent = chapterMap.get(ch.parentId)!;
        crumbs.push({ label: parent.title, target: parent.id });
      }
      crumbs.push({ label: ch.title, target: ch.id });
    }
    return crumbs;
  }, [ue, selectedChapterId, themeGroups, chapterMap]);

  const officialDocs = useMemo(
    () => visibleDocuments.filter((d) => d.category === "OFFICIAL_COURSE"),
    [visibleDocuments]
  );

  const studentNotes = useMemo(
    () =>
      visibleDocuments.filter(
        (d) =>
          d.category === "STUDENT_NOTE" && (!validatedOnly || d.isPinned)
      ),
    [visibleDocuments, validatedOnly]
  );

  function selectNode(nodeId: string) {
    setSelectedChapterId(nodeId);
    if (nodeId !== "ALL" && !nodeId.startsWith("THEME:")) {
      setUploadChapterId(nodeId);
      setExpandedChapters((prev) => ({ ...prev, [nodeId]: true }));
      const ch = chapterMap.get(nodeId);
      if (ch) {
        const tKey = (ch.theme || "").trim() || GENERAL_THEME_KEY;
        setExpandedThemes((prev) => ({ ...prev, [tKey]: true }));
        if (ch.parentId) {
          setExpandedChapters((prev) => ({ ...prev, [ch.parentId!]: true }));
        }
      }
    } else if (nodeId.startsWith("THEME:")) {
      const tKey = nodeId.slice("THEME:".length);
      setExpandedThemes((prev) => ({ ...prev, [tKey]: true }));
      const grp = themeGroups.find((g) => g.key === tKey);
      if (grp?.nodes[0]) {
        setUploadChapterId(grp.nodes[0].chapter.id);
      }
    }
  }

  function handleExpandAllTree(expand: boolean) {
    const nextThemes: Record<string, boolean> = {};
    for (const g of themeGroups) {
      nextThemes[g.key] = expand;
    }
    const nextChapters: Record<string, boolean> = {};
    if (ue) {
      for (const ch of ue.chapters) {
        nextChapters[ch.id] = expand;
      }
    }
    setExpandedThemes(nextThemes);
    setExpandedChapters(nextChapters);
  }

  async function handleCreateChapter(e: React.FormEvent) {
    e.preventDefault();
    if (!newChapterTitle.trim() || creatingChapter) return;
    setCreatingChapter(true);
    try {
      const res = await fetch(`/api/ues/${ueId}/chapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newChapterTitle.trim(),
          theme: newChapterTheme.trim(),
          parentId: newChapterParentId || null,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { chapter?: { id: string; theme?: string } };
        setNewChapterTitle("");
        if (data.chapter?.id) {
          setUploadChapterId(data.chapter.id);
          const tKey = (data.chapter.theme || "").trim() || GENERAL_THEME_KEY;
          setExpandedThemes((prev) => ({ ...prev, [tKey]: true }));
          if (newChapterParentId) {
            setExpandedChapters((prev) => ({ ...prev, [newChapterParentId]: true }));
          }
        }
        setNewChapterParentId("");
        await fetchUE();
      }
    } finally {
      setCreatingChapter(false);
    }
  }

  function openEditChapter(ch: ChapterItem) {
    setEditingChapterId(ch.id);
    setEditChapterTitle(ch.title);
    setEditChapterTheme(ch.theme || "");
    setEditChapterParentId(ch.parentId || "");
  }

  async function handleSaveEditChapter(e: React.FormEvent) {
    e.preventDefault();
    if (!editingChapterId || !editChapterTitle.trim() || savingChapterEdit) return;
    setSavingChapterEdit(true);
    try {
      const res = await fetch(`/api/ues/${ueId}/chapters`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chapterId: editingChapterId,
          title: editChapterTitle.trim(),
          theme: editChapterTheme.trim(),
          parentId: editChapterParentId || null,
        }),
      });
      if (res.ok) {
        setEditingChapterId(null);
        await fetchUE();
      }
    } finally {
      setSavingChapterEdit(false);
    }
  }

  async function handleDeleteChapter(chapterId: string) {
    if (!confirm("Supprimer ce chapitre et tous ses documents associés ?")) {
      return;
    }
    const res = await fetch(
      `/api/ues/${ueId}/chapters?chapterId=${encodeURIComponent(chapterId)}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      if (selectedChapterId === chapterId) setSelectedChapterId("ALL");
      if (editingChapterId === chapterId) setEditingChapterId(null);
      await fetchUE();
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadChapterId || !uploadFile || uploading) return;

    setUploading(true);
    setUploadFeedback(null);

    try {
      const formData = new FormData();
      formData.append("chapterId", uploadChapterId);
      formData.append("title", uploadTitle.trim());
      formData.append("category", uploadCategory);
      formData.append("autoGenerate", autoGenerateOnUpload ? "true" : "false");
      formData.append("file", uploadFile);

      const res = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        document?: { id: string; title: string };
        generatedPack?: Array<{ id: string; kind: string; title: string }>;
      };

      if (!res.ok) {
        setUploadFeedback(data.error || "Échec de l'upload.");
        return;
      }

      if (data.document && data.generatedPack && data.generatedPack.length > 0) {
        setLastGeneratedPack({
          docTitle: data.document.title,
          docId: data.document.id,
          items: data.generatedPack,
        });
      }

      setUploadTitle("");
      setUploadFile(null);
      setUploadOpen(false);
      await fetchUE();
    } catch {
      setUploadFeedback("Erreur réseau lors de l'envoi du PDF.");
    } finally {
      setUploading(false);
    }
  }

  async function handleToggleUpvote(docId: string) {
    const res = await fetch(`/api/documents/${docId}/upvote`, {
      method: "POST",
    });
    if (res.ok) {
      await fetchUE();
    }
  }

  async function handleTogglePin(doc: DocItem) {
    const res = await fetch(`/api/documents/${doc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPinned: !doc.isPinned }),
    });
    if (res.ok) {
      await fetchUE();
    }
  }

  async function handleDeleteDoc(docId: string) {
    if (!confirm("Supprimer définitivement ce PDF ?")) return;
    const res = await fetch(`/api/documents/${docId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      if (activeDoc?.id === docId) setActiveDoc(null);
      await fetchUE();
    }
  }

  async function handleCreateWhiteboard(e: React.FormEvent) {
    e.preventDefault();
    if (!wbTitle.trim() || creatingWb) return;
    setCreatingWb(true);
    try {
      const res = await fetch("/api/whiteboards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: wbTitle.trim(),
          ueId,
          isPublic: wbPublic,
          autoIntegrate: canManage && wbPublic,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { whiteboard: { id: string } };
        setWbTitle("");
        router.push(`/whiteboard/${data.whiteboard.id}`);
      }
    } finally {
      setCreatingWb(false);
    }
  }

  async function handleUpdateWhiteboard(
    wbId: string,
    patch: { isPublic?: boolean; isIntegrated?: boolean }
  ) {
    const res = await fetch(`/api/whiteboards/${wbId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      await fetchUE();
    }
  }

  async function handleDeleteWhiteboard(wbId: string) {
    if (!confirm("Supprimer ce tableau blanc ?")) return;
    const res = await fetch(`/api/whiteboards/${wbId}`, { method: "DELETE" });
    if (res.ok) {
      await fetchUE();
    }
  }

  if (loading) {
    return (
      <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
        CHARGEMENT DE L&apos;ESPACE UE...
      </div>
    );
  }

  if (error || !ue) {
    return (
      <div className="border border-border bg-card p-8">
        <p className="font-mono text-xs uppercase tracking-wider text-carmine">
          {error || "UE INTROUVABLE"}
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex items-center gap-2 border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>RETOUR AUX UE</span>
        </Link>
      </div>
    );
  }

  const primaryChannel = ue.channels[0];
  const integratedBoards = ue.whiteboards.filter((wb) => wb.isIntegrated);
  const proposedPublicBoards = ue.whiteboards.filter(
    (wb) => wb.isPublic && !wb.isIntegrated
  );
  const myPrivateBoards = ue.whiteboards.filter(
    (wb) => wb.creatorId === session?.user?.id && !wb.isPublic
  );
  const examBadge = formatExamBadge(ue.examType, ue.examDate);

  const renderDocumentRow = (doc: DocItem, showCategoryBadge = false) => {
    const isActive = activeDoc?.id === doc.id;
    const canDelete = canManage || doc.authorId === session?.user?.id;
    const isNote = doc.category === "STUDENT_NOTE";

    return (
      <div
        key={doc.id}
        className={`ara-hover-lift flex flex-wrap items-center justify-between gap-3 p-4 ${
          isActive || doc.isPinned ? "bg-pinned" : "bg-card"
        }`}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {isNote ? (
            <button
              type="button"
              onClick={() => handleToggleUpvote(doc.id)}
              className={`flex w-12 shrink-0 flex-col items-center justify-center border py-1 font-mono text-xs transition-colors ${
                doc.hasUpvoted
                  ? "border-ink bg-ink text-card"
                  : "border-border bg-paper text-ink hover:border-ink"
              }`}
              title="Voter pour cette fiche"
            >
              <ArrowUp className="h-3 w-3" />
              <span className="text-[11px] font-bold">{doc.upvoteCount}</span>
            </button>
          ) : (
            <FileText className="mt-1 h-4 w-4 shrink-0 text-ink" />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-bold text-ink">
                {doc.title}
              </h3>
              {showCategoryBadge && (
                <span
                  className={`px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                    isNote
                      ? "border border-border bg-paper text-stone"
                      : "border border-ink bg-ink text-card"
                  }`}
                >
                  {isNote ? "NOTE ÉTUDIANTE" : "COURS OFFICIEL"}
                </span>
              )}
              {doc.isPinned && (
                <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                  VALIDÉ PAR RESP. UE
                </span>
              )}
              {!isNote && (
                <span
                  className={`px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                    doc.isIndexed
                      ? "bg-badge-bg text-badge-text"
                      : "border border-border bg-paper text-stone"
                  }`}
                >
                  {doc.isIndexed ? "RAG INDEXÉ" : "NON INDEXÉ"}
                </span>
              )}
            </div>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-stone">
              {isNote ? `PAR ${doc.author.name} · ` : ""}
              {doc.fileName} · {doc.pageCount} PAGES ·{" "}
              {formatBytes(doc.fileSize)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setStudioFocusDocId(doc.id);
              setActiveTab("studio");
            }}
            title="Ouvrir la fiche, flashcards et quiz de ce cours dans le Studio"
            className="inline-flex items-center gap-1 border border-border bg-paper px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned"
          >
            <Sparkles className="h-3 w-3" />
            <span>PACK RÉVISION</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveDoc(doc);
              setActivePage(1);
              setActiveTotalPages(doc.pageCount);
            }}
            className={
              isNote
                ? "border border-border bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-ink hover:bg-card"
                : "border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-card hover:bg-ink/90"
            }
          >
            {isActive ? "OUVERT" : "LIRE PDF"}
          </button>

          {canManage && isNote && (
            <button
              type="button"
              onClick={() => handleTogglePin(doc)}
              title={
                doc.isPinned
                  ? "Retirer la validation"
                  : "Épingler / Valider par Resp. UE"
              }
              className={`border p-1.5 ${
                doc.isPinned
                  ? "border-badge-text bg-badge-bg text-badge-text"
                  : "border-border bg-paper text-stone hover:text-ink"
              }`}
            >
              {doc.isPinned ? (
                <PinOff className="h-3.5 w-3.5" />
              ) : (
                <Pin className="h-3.5 w-3.5" />
              )}
            </button>
          )}

          {canDelete && (
            <button
              type="button"
              onClick={() => handleDeleteDoc(doc.id)}
              title="Supprimer"
              className="border border-border bg-paper p-1.5 text-stone hover:border-carmine hover:text-carmine"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderSidebarTreeNode = (node: ChapterTreeNode) => {
    const ch = node.chapter;
    const isSelected = selectedChapterId === ch.id;
    const isOpen = expandedChapters[ch.id] ?? false;
    const hasInner = node.children.length > 0 || ch.documents.length > 0;
    const excludedForEdit = chapterSubtreeMap.get(ch.id) || new Set([ch.id]);

    return (
      <div key={ch.id} className="border-t border-border/60">
        <div
          className={`group flex items-center justify-between gap-1.5 py-2 pr-2 transition-colors ${
            isSelected ? "bg-pinned" : "bg-card hover:bg-paper"
          }`}
          style={{ paddingLeft: `${10 + node.depth * 14}px` }}
        >
          <button
            type="button"
            onClick={() =>
              setExpandedChapters((prev) => ({
                ...prev,
                [ch.id]: !isOpen,
              }))
            }
            disabled={!hasInner}
            className="flex h-5 w-5 shrink-0 items-center justify-center text-stone hover:text-ink disabled:opacity-35"
            title={hasInner ? "Déplier / replier le chapitre" : "Chapitre vide"}
          >
            {hasInner ? (
              isOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )
            ) : node.depth > 0 ? (
              <CornerDownRight className="h-3 w-3" />
            ) : (
              <FileText className="h-3 w-3 opacity-40" />
            )}
          </button>

          <button
            type="button"
            onClick={() => selectNode(ch.id)}
            className="min-w-0 flex-1 text-left"
          >
            <span
              className={`block truncate text-xs ${
                isSelected ? "font-bold text-ink" : "font-medium text-ink"
              }`}
            >
              {ch.title}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-stone">
              {node.totalDocsCount} PDF
              {node.children.length > 0
                ? ` · ${node.children.length} SOUS-CHAP.`
                : ""}
            </span>
          </button>

          {canManage && (
            <div className="flex shrink-0 items-center gap-1 opacity-75 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => {
                  setNewChapterParentId(ch.id);
                  setNewChapterTheme(ch.theme || "");
                }}
                title="Ajouter un sous-chapitre ici"
                className="p-0.5 text-stone hover:text-ink"
              >
                <Plus className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() =>
                  editingChapterId === ch.id
                    ? setEditingChapterId(null)
                    : openEditChapter(ch)
                }
                title="Modifier thème / parent / titre"
                className="p-0.5 text-stone hover:text-ink"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => handleDeleteChapter(ch.id)}
                title="Supprimer ce chapitre"
                className="p-0.5 text-stone hover:text-carmine"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        {canManage && editingChapterId === ch.id && (
          <form
            onSubmit={handleSaveEditChapter}
            className="ara-tree-collapse space-y-2 border-t border-border bg-paper p-2.5"
          >
            <p className="font-mono text-[9px] font-bold uppercase tracking-wider text-stone">
              MODIFIER L&apos;EMPLACEMENT
            </p>
            <input
              type="text"
              list="ue-themes-datalist"
              value={editChapterTheme}
              onChange={(e) => setEditChapterTheme(e.target.value)}
              placeholder="Thème (optionnel)..."
              className="w-full border border-border bg-card px-2 py-1 text-xs text-ink focus:border-ink focus:outline-none"
            />
            <select
              value={editChapterParentId}
              onChange={(e) => setEditChapterParentId(e.target.value)}
              className="w-full border border-border bg-card px-2 py-1 text-xs text-ink focus:border-ink focus:outline-none"
            >
              <option value="">— Chapitre racine (sans parent) —</option>
              {flatChapters
                .filter((item) => !excludedForEdit.has(item.chapter.id))
                .map((item) => (
                  <option key={item.chapter.id} value={item.chapter.id}>
                    {"↳ ".repeat(item.depth)}
                    {item.chapter.theme ? `[${item.chapter.theme}] ` : ""}
                    {item.chapter.title}
                  </option>
                ))}
            </select>
            <input
              type="text"
              required
              value={editChapterTitle}
              onChange={(e) => setEditChapterTitle(e.target.value)}
              placeholder="Titre du chapitre..."
              className="w-full border border-border bg-card px-2 py-1 text-xs text-ink focus:border-ink focus:outline-none"
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setEditingChapterId(null)}
                className="border border-border bg-card px-2 py-1 font-mono text-[9px] uppercase text-stone"
              >
                ANNULER
              </button>
              <button
                type="submit"
                disabled={savingChapterEdit || !editChapterTitle.trim()}
                className="border border-ink bg-ink px-2.5 py-1 font-mono text-[9px] uppercase text-card disabled:opacity-50"
              >
                {savingChapterEdit ? "..." : "ENREGISTRER"}
              </button>
            </div>
          </form>
        )}

        {isOpen && hasInner && (
          <div className="ara-tree-collapse">
            {ch.documents.map((doc) => {
              const isDocActive = activeDoc?.id === doc.id;
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => {
                    setActiveDoc(doc);
                    setActivePage(1);
                    setActiveTotalPages(doc.pageCount);
                  }}
                  className={`flex w-full items-center gap-1.5 border-t border-border/40 py-1.5 pr-3 text-left transition-colors ${
                    isDocActive
                      ? "bg-ink text-card"
                      : "bg-paper/60 text-ink hover:bg-pinned"
                  }`}
                  style={{ paddingLeft: `${26 + node.depth * 14}px` }}
                >
                  <FileText
                    className={`h-3 w-3 shrink-0 ${
                      isDocActive ? "text-card" : "text-stone"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px]">
                    {doc.title}
                  </span>
                  <span
                    className={`shrink-0 font-mono text-[9px] uppercase ${
                      isDocActive ? "text-card/80" : "text-stone"
                    }`}
                  >
                    {doc.category === "OFFICIAL_COURSE" ? "CM" : "NOTE"}
                  </span>
                </button>
              );
            })}
            {node.children.map((child) => renderSidebarTreeNode(child))}
          </div>
        )}
      </div>
    );
  };

  const renderCenterTreeNode = (node: ChapterTreeNode): React.ReactNode => {
    const ch = node.chapter;
    const isVisible = visibleChapterIds.has(ch.id);
    const docs = ch.documents.filter(
      (d) =>
        !validatedOnly || d.category === "OFFICIAL_COURSE" || d.isPinned
    );
    const visibleChildren = node.children.filter((c) =>
      visibleChapterIds.has(c.chapter.id)
    );

    if (!isVisible && visibleChildren.length === 0) {
      return null;
    }

    return (
      <div
        key={ch.id}
        className={
          node.depth > 0 ? "mt-3 border-l-2 border-border pl-4" : "mt-3 first:mt-0"
        }
      >
        <div className="border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-4 py-2.5">
            <div className="flex items-center gap-2">
              {node.depth > 0 && (
                <CornerDownRight className="h-3.5 w-3.5 text-stone" />
              )}
              <FolderOpen className="h-3.5 w-3.5 text-ink" />
              <span className="text-sm font-bold text-ink">{ch.title}</span>
              <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                {docs.length} FICHIER{docs.length > 1 ? "S" : ""}
              </span>
            </div>

            <button
              type="button"
              onClick={() => {
                setUploadChapterId(ch.id);
                setUploadCategory(canManage ? "OFFICIAL_COURSE" : "STUDENT_NOTE");
                setUploadOpen(true);
              }}
              className="inline-flex items-center gap-1 border border-border bg-card px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned"
            >
              <Plus className="h-3 w-3" />
              <span>DÉPOSER ICI</span>
            </button>
          </div>

          {docs.length === 0 ? (
            <div className="px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-stone">
              {validatedOnly
                ? "AUCUNE RESSOURCE VALIDÉE DANS CE CHAPITRE."
                : "AUCUN FICHIER DÉPOSÉ DIRECTEMENT DANS CE CHAPITRE."}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {docs.map((doc) => renderDocumentRow(doc, true))}
            </div>
          )}
        </div>

        {visibleChildren.map((child) => renderCenterTreeNode(child))}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* UE Top Masthead */}
      <div
        className="border border-border bg-card"
        style={{ borderTop: `3px solid ${ue.accentColor || "#D99B26"}` }}
      >
        <div className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="flex items-start gap-3">
            <Link
              href="/"
              className="mt-0.5 flex h-8 w-8 items-center justify-center border border-border bg-paper text-ink hover:bg-pinned"
              title="Retour à la liste des UE"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-stone">
                  {ue.code} · {ue.semester} · {ue.classLevel || "VET2"}
                </span>
                <span className="border border-border bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink">
                  {examBadge.typeLabel} : {examBadge.dateLabel}
                  {examBadge.countdownLabel ? ` (${examBadge.countdownLabel})` : ""}
                </span>
                <span className="border border-border bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                  COEFF : {ue.coeff ?? 4}
                </span>
                {ue.roles.map((r) => (
                  <span
                    key={r.id}
                    className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text"
                  >
                    RESP: {r.user.name}
                  </span>
                ))}
                {canManage && (
                  <span className="border border-ink bg-ink px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-card">
                    DROITS GESTIONNAIRE
                  </span>
                )}
              </div>
              <h1 className="mt-1 text-xl font-bold uppercase tracking-tight text-ink">
                {ue.title}
              </h1>
              {ue.description && (
                <p className="mt-1 text-sm text-stone">{ue.description}</p>
              )}
            </div>
          </div>

          {activeTab === "courses" && (
            <button
              type="button"
              onClick={() => {
                setUploadCategory(canManage ? "OFFICIAL_COURSE" : "STUDENT_NOTE");
                setUploadOpen((prev) => !prev);
              }}
              className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>DÉPOSER UN PDF</span>
            </button>
          )}
        </div>

        {/* Dedicated UE Navigation Tabs */}
        <div className="flex flex-wrap items-center gap-1 border-t border-border bg-paper px-4">
          <button
            type="button"
            onClick={() => setActiveTab("courses")}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
              activeTab === "courses"
                ? "border-ink bg-card font-semibold text-ink"
                : "border-transparent text-stone hover:text-ink"
            }`}
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span>COURS &amp; NOTES ({allUeDocuments.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("discussion")}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
              activeTab === "discussion"
                ? "border-ink bg-card font-semibold text-ink"
                : "border-transparent text-stone hover:text-ink"
            }`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>DISCUSSION DE L&apos;UE</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("whiteboards")}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
              activeTab === "whiteboards"
                ? "border-ink bg-card font-semibold text-ink"
                : "border-transparent text-stone hover:text-ink"
            }`}
          >
            <PenTool className="h-3.5 w-3.5" />
            <span>
              TABLEAUX BLANCS ({integratedBoards.length} INTÉGRÉS)
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("studio")}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
              activeTab === "studio"
                ? "border-ink bg-card font-semibold text-ink"
                : "border-transparent text-stone hover:text-ink"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>STUDIO NOTEBOOK (SVG · FLASHCARDS)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("exam")}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
              activeTab === "exam"
                ? "border-ink bg-card font-semibold text-ink"
                : "border-transparent text-stone hover:text-ink"
            }`}
          >
            <Timer className="h-3.5 w-3.5" />
            <span>PARTIEL BLANC (CHRONO)</span>
          </button>
        </div>
      </div>

      {/* TAB 1: COURS & NOTES PDF */}
      {activeTab === "courses" && (
        <div className="ara-animate-in space-y-4">
          <datalist id="ue-themes-datalist">
            {existingThemes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>

          {uploadOpen && (
            <form
              onSubmit={handleUpload}
              className="ara-animate-in border border-ink bg-card p-5"
            >
              <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                  TÉLÉVERSER UN DOCUMENT PDF (INDEXATION RAG AUTOMATIQUE)
                </span>
                <button
                  type="button"
                  onClick={() => setUploadOpen(false)}
                  className="text-stone hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {uploadFeedback && (
                <div className="mb-4 border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
                  {uploadFeedback}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    CHAPITRE CIBLE
                  </label>
                  <select
                    required
                    value={uploadChapterId}
                    onChange={(e) => setUploadChapterId(e.target.value)}
                    className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                  >
                    {ue.chapters.length === 0 && (
                      <option value="">Aucun chapitre</option>
                    )}
                    {themeGroups.map((grp) => (
                      <optgroup key={grp.key} label={grp.label}>
                        {flatChapters
                          .filter((item) => item.themeLabel === grp.label)
                          .map((item) => (
                            <option
                              key={item.chapter.id}
                              value={item.chapter.id}
                            >
                              {"↳ ".repeat(item.depth)}
                              {item.chapter.title}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    CATÉGORIE
                  </label>
                  <select
                    value={uploadCategory}
                    onChange={(e) =>
                      setUploadCategory(
                        e.target.value === "OFFICIAL_COURSE"
                          ? "OFFICIAL_COURSE"
                          : "STUDENT_NOTE"
                      )
                    }
                    className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
                  >
                    <option value="STUDENT_NOTE">NOTE ÉTUDIANTE</option>
                    {canManage && (
                      <option value="OFFICIAL_COURSE">COURS OFFICIEL</option>
                    )}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    TITRE DU DOCUMENT
                  </label>
                  <input
                    type="text"
                    value={uploadTitle}
                    onChange={(e) => setUploadTitle(e.target.value)}
                    placeholder="Ex : Ostéologie membre thoracique"
                    className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    FICHIER PDF
                  </label>
                  <input
                    type="file"
                    required
                    accept="application/pdf,.pdf"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    className="w-full border border-border bg-paper px-2 py-1.5 font-mono text-xs text-ink"
                  />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <label className="flex cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink">
                  <input
                    type="checkbox"
                    checked={autoGenerateOnUpload}
                    onChange={(e) => setAutoGenerateOnUpload(e.target.checked)}
                    className="h-3.5 w-3.5 accent-ink"
                  />
                  <span>
                    GÉNÉRER AUTOMATIQUEMENT À L&apos;UPLOAD : FICHE DE RÉVISION +
                    FLASHCARDS + QUIZ
                  </span>
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setUploadOpen(false)}
                    className="border border-border bg-paper px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink"
                  >
                    ANNULER
                  </button>
                  <button
                    type="submit"
                    disabled={uploading || !uploadFile || !uploadChapterId}
                    className="border border-ink bg-ink px-5 py-2 font-mono text-xs uppercase tracking-wider text-card disabled:opacity-50"
                  >
                    {uploading
                      ? autoGenerateOnUpload
                        ? "ENVOI & GÉNÉRATION DU PACK..."
                        : "INDEXATION & ENVOI..."
                      : "PUBLIER LE PDF"}
                  </button>
                </div>
              </div>
            </form>
          )}

          {lastGeneratedPack && (
            <div
              className="ara-animate-in flex flex-wrap items-center justify-between gap-3 border border-forest bg-forest/10 px-4 py-3"
              style={{ borderLeft: "3px solid #3B7A57" }}
            >
              <div>
                <p className="font-mono text-xs font-bold uppercase tracking-wider text-forest">
                  PACK DE RÉVISION GÉNÉRÉ POUR « {lastGeneratedPack.docTitle} »
                </p>
                <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink">
                  FICHE SYNTHÈSE · FLASHCARDS · QUIZ CIBLÉ ({lastGeneratedPack.items.length}{" "}
                  RESSOURCES CRÉÉES)
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setStudioFocusDocId(lastGeneratedPack.docId);
                    setActiveTab("studio");
                  }}
                  className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-card hover:bg-ink/90"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>CONSULTER DANS LE STUDIO →</span>
                </button>
                <button
                  type="button"
                  onClick={() => setLastGeneratedPack(null)}
                  className="border border-border bg-card p-1 text-stone hover:text-ink"
                  title="Fermer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* Left: Hierarchical Tree (Thème ▸ Chapitre ▸ Sous-chapitre ▸ Fichiers) */}
            <aside className="space-y-4 lg:col-span-4 xl:col-span-3">
              <div className="border border-border bg-card">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-paper px-3.5 py-2.5">
                  <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                    ARBORESCENCE ({ue.chapters.length})
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleExpandAllTree(true)}
                      title="Tout déplier"
                      className="border border-border bg-card p-1 text-stone hover:border-ink hover:text-ink"
                    >
                      <ChevronsUpDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExpandAllTree(false)}
                      title="Tout replier"
                      className="border border-border bg-card p-1 text-stone hover:border-ink hover:text-ink"
                    >
                      <ChevronsDownUp className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => selectNode("ALL")}
                    className={`flex w-full items-center justify-between px-3.5 py-2.5 text-left font-mono text-xs uppercase tracking-wider transition-colors ${
                      selectedChapterId === "ALL"
                        ? "bg-pinned font-semibold text-ink"
                        : "bg-card text-stone hover:bg-paper hover:text-ink"
                    }`}
                  >
                    <span>TOUTE L&apos;ARBORESCENCE</span>
                    <span>{allUeDocuments.length}</span>
                  </button>

                  {themeGroups.map((grp) => {
                    const themeNodeId = `THEME:${grp.key}`;
                    const isThemeSelected = selectedChapterId === themeNodeId;
                    const isThemeOpen = expandedThemes[grp.key] ?? true;

                    return (
                      <div key={grp.key} className="border-t border-border">
                        <div
                          className={`group flex items-center justify-between gap-1.5 px-2.5 py-2 transition-colors ${
                            isThemeSelected
                              ? "bg-pinned"
                              : "bg-paper/75 hover:bg-paper"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedThemes((prev) => ({
                                ...prev,
                                [grp.key]: !isThemeOpen,
                              }))
                            }
                            className="flex h-5 w-5 shrink-0 items-center justify-center text-stone hover:text-ink"
                            title="Déplier / replier ce thème"
                          >
                            {isThemeOpen ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => selectNode(themeNodeId)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          >
                            {isThemeOpen ? (
                              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink" />
                            ) : (
                              <Folder className="h-3.5 w-3.5 shrink-0 text-stone" />
                            )}
                            <div className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                                {grp.label}
                              </span>
                              <span className="font-mono text-[9px] uppercase tracking-wider text-stone">
                                {grp.chapterCount} CHAP · {grp.totalDocsCount} PDF
                              </span>
                            </div>
                          </button>

                          {canManage && (
                            <button
                              type="button"
                              onClick={() => {
                                setNewChapterTheme(
                                  grp.isDefaultGeneral ? "" : grp.label
                                );
                                setNewChapterParentId("");
                              }}
                              title={`Ajouter un chapitre dans ${grp.label}`}
                              className="p-1 text-stone opacity-75 hover:text-ink group-hover:opacity-100"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          )}
                        </div>

                        {isThemeOpen && (
                          <div className="ara-tree-collapse">
                            {grp.nodes.map((node) => renderSidebarTreeNode(node))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {canManage && (
                  <form
                    onSubmit={handleCreateChapter}
                    className="space-y-2 border-t border-border bg-paper p-3"
                  >
                    <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-stone">
                      AJOUTER UN THÈME / CHAPITRE
                    </p>
                    <input
                      type="text"
                      list="ue-themes-datalist"
                      value={newChapterTheme}
                      onChange={(e) => setNewChapterTheme(e.target.value)}
                      placeholder="Thème / Partie (ex : Ostéologie)..."
                      className="w-full border border-border bg-card px-2.5 py-1.5 text-xs text-ink placeholder:text-stone focus:border-ink focus:outline-none"
                    />
                    <select
                      value={newChapterParentId}
                      onChange={(e) => setNewChapterParentId(e.target.value)}
                      className="w-full border border-border bg-card px-2.5 py-1.5 text-xs text-ink focus:border-ink focus:outline-none"
                    >
                      <option value="">
                        — Niveau racine (Chapitre principal) —
                      </option>
                      {flatChapters.map((item) => (
                        <option key={item.chapter.id} value={item.chapter.id}>
                          Sous-chapitre de : {"↳ ".repeat(item.depth)}
                          {item.chapter.theme ? `[${item.chapter.theme}] ` : ""}
                          {item.chapter.title}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={newChapterTitle}
                        onChange={(e) => setNewChapterTitle(e.target.value)}
                        placeholder="Titre du chapitre..."
                        className="min-w-0 flex-1 border border-border bg-card px-2.5 py-1.5 text-xs text-ink placeholder:text-stone focus:border-ink focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={creatingChapter || !newChapterTitle.trim()}
                        title="Créer dans l'arborescence"
                        className="border border-ink bg-ink px-2.5 py-1.5 text-card disabled:opacity-50"
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </aside>

            {/* Center: Breadcrumb + View Mode + Custom PDF Reader + Documents */}
            <section className="space-y-4 lg:col-span-8 xl:col-span-9">
              {activeDoc && (
                <div className="ara-animate-in">
                  <CustomPdfReader
                    documentId={activeDoc.id}
                    ueId={ue.id}
                    title={activeDoc.title}
                    fileName={activeDoc.fileName}
                    initialPage={activePage}
                    pageCountHint={activeDoc.pageCount}
                    onPageChange={handleReaderPageChange}
                    onCreateQuizFromCapture={(imageDataUrl, pageNumber) => {
                      setCapturedQuizSeed({
                        id: `cap-${Date.now()}`,
                        imageDataUrl,
                        title: `${ue.code} · Schéma P.${pageNumber} (${activeDoc.title})`,
                      });
                      setActiveTab("studio");
                    }}
                    onClose={() => setActiveDoc(null)}
                  />
                </div>
              )}

              {/* Breadcrumb & View Switcher */}
              <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-2.5">
                <nav
                  aria-label="Fil d'Ariane"
                  className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider"
                >
                  {activeBreadcrumb.map((crumb, idx) => {
                    const isLast = idx === activeBreadcrumb.length - 1;
                    return (
                      <span key={`${crumb.target}-${idx}`} className="inline-flex items-center gap-1.5">
                        {idx > 0 && (
                          <ChevronRight className="h-3 w-3 text-stone" />
                        )}
                        <button
                          type="button"
                          onClick={() => selectNode(crumb.target)}
                          className={
                            isLast
                              ? "font-bold text-ink"
                              : "text-stone hover:text-ink hover:underline"
                          }
                        >
                          {crumb.label}
                        </button>
                      </span>
                    );
                  })}
                </nav>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setValidatedOnly((prev) => !prev)}
                    className={`inline-flex items-center gap-1 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                      validatedOnly
                        ? "border-badge-text bg-badge-bg text-badge-text"
                        : "border-border bg-paper text-stone hover:text-ink"
                    }`}
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    <span>VALIDÉES</span>
                  </button>

                  <div className="flex border border-border bg-paper">
                    <button
                      type="button"
                      onClick={() => setCourseViewMode("tree")}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                        courseViewMode === "tree"
                          ? "bg-ink font-semibold text-card"
                          : "text-stone hover:text-ink"
                      }`}
                    >
                      <FolderTree className="h-3 w-3" />
                      <span>ARBORESCENCE</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCourseViewMode("category")}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                        courseViewMode === "category"
                          ? "bg-ink font-semibold text-card"
                          : "text-stone hover:text-ink"
                      }`}
                    >
                      <Layers className="h-3 w-3" />
                      <span>CATÉGORIES</span>
                    </button>
                  </div>
                </div>
              </div>

              {courseViewMode === "tree" ? (
                <div className="ara-animate-in space-y-4">
                  {themeGroups.length === 0 ? (
                    <div className="border border-border bg-card p-8 text-center">
                      <p className="font-mono text-xs uppercase tracking-wider text-stone">
                        AUCUN THÈME OU CHAPITRE CRÉÉ DANS CETTE UE POUR
                        L&apos;INSTANT.
                      </p>
                    </div>
                  ) : (
                    themeGroups.map((grp) => {
                      const hasVisible = grp.nodes.some((n) => {
                        const sub =
                          chapterSubtreeMap.get(n.chapter.id) ||
                          new Set([n.chapter.id]);
                        return Array.from(sub).some((id) =>
                          visibleChapterIds.has(id)
                        );
                      });
                      if (!hasVisible) return null;

                      return (
                        <div
                          key={grp.key}
                          className="border border-border bg-paper/50 p-4"
                          style={{
                            borderTop: `3px solid ${ue.accentColor || "#D99B26"}`,
                          }}
                        >
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                            <div className="flex items-center gap-2">
                              <Folder className="h-4 w-4 text-ink" />
                              <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
                                THÈME · {grp.label}
                              </h2>
                            </div>
                            <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                              {grp.chapterCount} CHAPITRE
                              {grp.chapterCount > 1 ? "S" : ""} ·{" "}
                              {grp.totalDocsCount} PDF
                            </span>
                          </div>

                          <div className="space-y-3">
                            {grp.nodes.map((node) => renderCenterTreeNode(node))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : (
                <div className="ara-animate-in space-y-4">
                  {/* Official Courses Section */}
                  <div className="border border-border bg-card">
                    <div className="flex items-center justify-between border-b border-border bg-paper px-4 py-2.5">
                      <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                        COURS OFFICIELS ({officialDocs.length})
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                        SUPPORTS MAGISTRAUX &amp; POLYCOPIÉS
                      </span>
                    </div>

                    {officialDocs.length === 0 ? (
                      <div className="p-6 text-center">
                        <p className="font-mono text-xs uppercase tracking-wider text-stone">
                          AUCUN COURS OFFICIEL DANS CETTE SÉLECTION.
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {officialDocs.map((doc) => renderDocumentRow(doc, false))}
                      </div>
                    )}
                  </div>

                  {/* Student Notes Section */}
                  <div className="border border-border bg-card">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-4 py-2.5">
                      <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                        NOTES ÉTUDIANTES ({studentNotes.length})
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                        FICHES &amp; PARTAGES DE PROMO
                      </span>
                    </div>

                    {studentNotes.length === 0 ? (
                      <div className="p-6 text-center">
                        <p className="font-mono text-xs uppercase tracking-wider text-stone">
                          AUCUNE NOTE ÉTUDIANTE{" "}
                          {validatedOnly ? "VALIDÉE " : ""}POUR L&apos;INSTANT.
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {studentNotes.map((doc) => renderDocumentRow(doc, false))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* TAB 2: DISCUSSION DE L'UE */}
      {activeTab === "discussion" && primaryChannel && (
        <UEDiscussionPanel
          channelId={primaryChannel.id}
          channelName={primaryChannel.name}
          ueId={ue.id}
          ueCode={ue.code}
          documents={allUeDocuments}
          whiteboards={ue.whiteboards}
          onOpenDocument={(docId) => {
            const found = allUeDocuments.find((d) => d.id === docId);
            if (found) {
              setActiveTab("courses");
              setActiveDoc(found);
              setActivePage(1);
              setActiveTotalPages(found.pageCount);
            }
          }}
        />
      )}

      {/* TAB 3: TABLEAUX BLANCS DE L'UE */}
      {activeTab === "whiteboards" && (
        <div className="space-y-6">
          {/* Quick Whiteboard Creator */}
          <form
            onSubmit={handleCreateWhiteboard}
            className="flex flex-wrap items-end gap-3 border border-border bg-card p-4"
            style={{ borderTop: `3px solid ${ue.accentColor || "#3D6B99"}` }}
          >
            <div className="min-w-[220px] flex-1">
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                CRÉER UN TABLEAU BLANC POUR {ue.code}
              </label>
              <input
                type="text"
                required
                value={wbTitle}
                onChange={(e) => setWbTitle(e.target.value)}
                placeholder="Ex : Schéma synthèse chapitre 2"
                className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
              />
            </div>

            <div className="w-64">
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                VISIBILITÉ INITIALE
              </label>
              <select
                value={wbPublic ? "PUBLIC" : "PRIVATE"}
                onChange={(e) => setWbPublic(e.target.value === "PUBLIC")}
                className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
              >
                <option value="PRIVATE">PRIVÉ (MOI UNIQUEMENT)</option>
                <option value="PUBLIC">
                  {canManage
                    ? "PUBLIC & INTÉGRÉ À L'UE"
                    : "PUBLIC (PROPOSER À L'UE)"}
                </option>
              </select>
            </div>

            <button
              type="submit"
              disabled={creatingWb || !wbTitle.trim()}
              className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{creatingWb ? "CRÉATION..." : "CRÉER & OUVRIR"}</span>
            </button>
          </form>

          {/* Sub-section A: Integrated Whiteboards */}
          <div className="border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border bg-paper px-4 py-2.5">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                TABLEAUX INTÉGRÉS À L&apos;UE ({integratedBoards.length})
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                VALIDÉS &amp; SÉLECTIONNÉS PAR LE RESPONSABLE D&apos;UE
              </span>
            </div>

            {integratedBoards.length === 0 ? (
              <div className="p-6 text-center font-mono text-xs uppercase tracking-wider text-stone">
                AUCUN TABLEAU BLANC INTÉGRÉ PAR LE RESPONSABLE D&apos;UE POUR
                L&apos;INSTANT.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {integratedBoards.map((wb) => (
                  <div
                    key={wb.id}
                    className="flex flex-wrap items-center justify-between gap-3 bg-pinned p-4"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-bold text-ink">
                          {wb.title}
                        </h3>
                        <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                          INTÉGRÉ PAR RESP. UE
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-stone">
                        PAR {wb.creator.name} · MÀJ{" "}
                        {new Date(wb.updatedAt).toLocaleDateString("fr-FR")}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={`/whiteboard/${wb.id}`}
                        className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-card hover:bg-ink/90"
                      >
                        <span>OUVRIR</span>
                        <ArrowUpRight className="h-3 w-3" />
                      </Link>
                      {canManage && (
                        <button
                          type="button"
                          onClick={() =>
                            handleUpdateWhiteboard(wb.id, {
                              isIntegrated: false,
                            })
                          }
                          className="border border-border bg-card px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-stone hover:border-carmine hover:text-carmine"
                        >
                          RETIRER DE L&apos;UE
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sub-section B: Public Student Whiteboards proposed to UE */}
          <div className="border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border bg-paper px-4 py-2.5">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                TABLEAUX PUBLICS DE L&apos;UE ({proposedPublicBoards.length})
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                PARTAGÉS PAR LES ÉTUDIANTS · EN ATTENTE D&apos;INTÉGRATION
              </span>
            </div>

            {proposedPublicBoards.length === 0 ? (
              <div className="p-6 text-center font-mono text-xs uppercase tracking-wider text-stone">
                AUCUN TABLEAU PUBLIC PROPOSÉ POUR CETTE UE.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {proposedPublicBoards.map((wb) => {
                  const isMine = wb.creatorId === session?.user?.id;
                  return (
                    <div
                      key={wb.id}
                      className="flex flex-wrap items-center justify-between gap-3 p-4"
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-bold text-ink">
                            {wb.title}
                          </h3>
                          <span className="inline-flex items-center gap-1 border border-forest/40 bg-forest/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-forest">
                            <Globe className="h-3 w-3" />
                            PUBLIC
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-stone">
                          PAR {wb.creator.name} · MÀJ{" "}
                          {new Date(wb.updatedAt).toLocaleDateString("fr-FR")}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {canManage && (
                          <button
                            type="button"
                            onClick={() =>
                              handleUpdateWhiteboard(wb.id, {
                                isIntegrated: true,
                              })
                            }
                            className="inline-flex items-center gap-1 border border-badge-text bg-badge-bg px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-badge-text hover:bg-badge-text hover:text-card"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>INTÉGRER À L&apos;UE</span>
                          </button>
                        )}

                        <Link
                          href={`/whiteboard/${wb.id}`}
                          className="inline-flex items-center gap-1 border border-border bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-ink"
                        >
                          <span>OUVRIR</span>
                          <ArrowUpRight className="h-3 w-3" />
                        </Link>

                        {isMine && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateWhiteboard(wb.id, {
                                  isPublic: false,
                                })
                              }
                              className="border border-border bg-paper px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-stone hover:text-ink"
                            >
                              PASSER PRIVÉ
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteWhiteboard(wb.id)}
                              className="border border-border bg-paper p-1.5 text-stone hover:border-carmine hover:text-carmine"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sub-section C: My Private Whiteboards on this UE */}
          {myPrivateBoards.length > 0 && (
            <div className="border border-border bg-card">
              <div className="border-b border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                MES TABLEAUX PRIVÉS SUR {ue.code} ({myPrivateBoards.length})
              </div>
              <div className="divide-y divide-border">
                {myPrivateBoards.map((wb) => (
                  <div
                    key={wb.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-bold text-ink">
                          {wb.title}
                        </h3>
                        <span className="inline-flex items-center gap-1 border border-border bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                          <Lock className="h-3 w-3" />
                          PRIVÉ
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-stone">
                        VISIBLE UNIQUEMENT PAR VOUS
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateWhiteboard(wb.id, { isPublic: true })
                        }
                        className="inline-flex items-center gap-1 border border-border bg-paper px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
                      >
                        <Globe className="h-3 w-3" />
                        <span>RENDRE PUBLIC</span>
                      </button>
                      <Link
                        href={`/whiteboard/${wb.id}`}
                        className="inline-flex items-center gap-1 border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-card"
                      >
                        <span>OUVRIR</span>
                        <ArrowUpRight className="h-3 w-3" />
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleDeleteWhiteboard(wb.id)}
                        className="border border-border bg-paper p-1.5 text-stone hover:border-carmine hover:text-carmine"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: STUDIO NOTEBOOK */}
      {activeTab === "studio" && (
        <div className="space-y-8">
          <NotebookStudioPanel
            ueId={ue.id}
            ueCode={ue.code}
            documents={allUeDocuments}
            focusDocumentId={studioFocusDocId}
            onOpenSource={(src) => {
              const found = allUeDocuments.find((d) => d.id === src.documentId);
              if (found) {
                setActiveTab("courses");
                setActiveDoc(found);
                setActivePage(src.pageNumber);
                setActiveTotalPages(found.pageCount);
              }
            }}
          />

          <div className="border-t border-border pt-6">
            <CommunityQuizSection
              fixedUeId={ue.id}
              canManageFixedUe={canManage}
              documents={allUeDocuments}
              initialCapture={capturedQuizSeed}
              onConsumeInitialCapture={() => setCapturedQuizSeed(null)}
            />
          </div>
        </div>
      )}

      {/* TAB 5: PARTIEL BLANC CHRONOMÉTRÉ */}
      {activeTab === "exam" && (
        <MockExamPanel
          ueId={ue.id}
          ueCode={ue.code}
          ueTitle={ue.title}
          hasDocuments={allUeDocuments.length > 0}
          onOpenDocumentPage={(docId, pageNum) => {
            const found = allUeDocuments.find((d) => d.id === docId);
            if (found) {
              setActiveTab("courses");
              setActiveDoc(found);
              setActivePage(pageNum);
              setActiveTotalPages(found.pageCount);
            }
          }}
        />
      )}
    </div>
  );
}

export default function UEPage() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
            CHARGEMENT DE L&apos;UE...
          </div>
        }
      >
        <UEWorkspaceContent />
      </Suspense>
    </AppShell>
  );
}
