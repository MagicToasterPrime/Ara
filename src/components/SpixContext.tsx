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
  registerDocNavigator: (fn: DocNavigator | null) => void;
  navigateToDocPage: (
    documentId: string,
    pageNumber: number,
    ueId: string
  ) => boolean;
}

const SpixReactContext = createContext<SpixContextValue | null>(null);

export function SpixProvider({ children }: { children: ReactNode }) {
  const [pageContext, setPageContextState] = useState<SpixPageContext>({
    mode: "GLOBAL",
  });
  const [isOpen, setIsOpen] = useState(false);
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

  return (
    <SpixReactContext.Provider
      value={{
        pageContext,
        setPageContext,
        isOpen,
        setIsOpen,
        registerDocNavigator,
        navigateToDocPage,
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
