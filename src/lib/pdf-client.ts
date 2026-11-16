export async function renderPdfPageToDataUrl(
  documentId: string,
  pageNumber = 1,
  maxWidth = 1000
): Promise<string | null> {
  if (typeof window === "undefined") return null;

  try {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

    const loadingTask = pdfjsLib.getDocument({
      url: `/api/files/${documentId}`,
      withCredentials: true,
    });
    const doc = await loadingTask.promise;
    const clampedPage = Math.max(1, Math.min(pageNumber, doc.numPages));
    const page = await doc.getPage(clampedPage);

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, maxWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      await doc.destroy();
      return null;
    }

    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    await doc.destroy();
    return dataUrl;
  } catch (err) {
    console.warn("[pdf-client] Page capture warning:", err);
    return null;
  }
}
