"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type SpixContextMode = "GLOBAL" | "UE" | "DOCUMENT";

export interface SpixPageContext {
  mode: SpixContextMode;
  ueId?: string;
  ueCode?: string;
  ueTitle?: string;
  ueAccentColor?: string;
  chapterId?: string;
  chapterTitle?: string;
  documentId?: string;
  documentTitle?: string;
  fileName?: string;
  currentPage?: number;
  pageCount?: number;
}

export interface SpixPendingImagePrompt {
  id: string;
  imageDataUrl: string;
  prompt: string;
  pageNumber?: number;
}

type DocNavigator = (
  documentId: string,
  pageNumber: number,
  ueId: string
) => boolean;

interface SpixContextValue {
  pageContext: SpixPageContext;
  setPageContext: (ctx: SpixPageContext) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  userAiAndSpixEnabled: boolean;
  setUserAiAndSpixEnabled: (enabled: boolean) => void;
  registerDocNavigator: (fn: DocNavigator | null) => void;
  navigateToDocPage: (
    documentId: string,
    pageNumber: number,
    ueId: string
  ) => boolean;
  pendingImagePrompt: SpixPendingImagePrompt | null;
  triggerSpixImagePrompt: (payload: {
    imageDataUrl: string;
    prompt: string;
    pageNumber?: number;
  }) => void;
  clearPendingImagePrompt: () => void;
}

const SpixReactContext = createContext<SpixContextValue | null>(null);

export function SpixProvider({ children }: { children: ReactNode }) {
  const [pageContext, setPageContextState] = useState<SpixPageContext>({
    mode: "GLOBAL",
  });
  const [isOpen, setIsOpen] = useState(false);
  const [userAiAndSpixEnabled, setUserAiAndSpixEnabled] = useState(true);
  const [pendingImagePrompt, setPendingImagePrompt] =
    useState<SpixPendingImagePrompt | null>(null);
  const navigatorRef = useRef<DocNavigator | null>(null);

  const setPageContext = useCallback((ctx: SpixPageContext) => {
    setPageContextState(ctx);
  }, []);

  const registerDocNavigator = useCallback((fn: DocNavigator | null) => {
    navigatorRef.current = fn;
  }, []);

  const navigateToDocPage = useCallback(
    (documentId: string, pageNumber: number, ueId: string) => {
      if (navigatorRef.current) {
        return navigatorRef.current(documentId, pageNumber, ueId);
      }
      return false;
    },
    []
  );

  const triggerSpixImagePrompt = useCallback(
    (payload: {
      imageDataUrl: string;
      prompt: string;
      pageNumber?: number;
    }) => {
      setIsOpen(true);
      setPendingImagePrompt({
        id: `img-${Date.now()}`,
        imageDataUrl: payload.imageDataUrl,
        prompt: payload.prompt,
        pageNumber: payload.pageNumber,
      });
    },
    []
  );

  const clearPendingImagePrompt = useCallback(() => {
    setPendingImagePrompt(null);
  }, []);

  return (
    <SpixReactContext.Provider
      value={{
        pageContext,
        setPageContext,
        isOpen,
        setIsOpen,
        userAiAndSpixEnabled,
        setUserAiAndSpixEnabled,
        registerDocNavigator,
        navigateToDocPage,
        pendingImagePrompt,
        triggerSpixImagePrompt,
        clearPendingImagePrompt,
      }}
    >
      {children}
    </SpixReactContext.Provider>
  );
}

export function useSpix() {
  const ctx = useContext(SpixReactContext);
  if (!ctx) {
    throw new Error("useSpix doit être utilisé à l'intérieur de SpixProvider");
  }
  return ctx;
}
