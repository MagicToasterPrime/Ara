export interface StudioStreamDoneEvent<TArtifact = unknown> {
  artifact?: TArtifact;
  autoPublishedFirst?: boolean;
  usedAi?: boolean;
  error?: string;
  code?: string;
  status?: number;
}

/**
 * Calls POST /api/studio with `streamProgress: true`, parses NDJSON progress ticks
 * in real time, and returns the final payload (gracefully handling non-streaming JSON errors).
 */
export async function requestStudioArtifactStream<TArtifact = unknown>(
  payload: Record<string, unknown>,
  onProgress?: (percent: number, label: string) => void
): Promise<{
  ok: boolean;
  status: number;
  data: StudioStreamDoneEvent<TArtifact>;
}> {
  const res = await fetch("/api/studio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, streamProgress: true }),
  });

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/x-ndjson") || !res.body) {
    const json = (await res.json().catch(() => ({}))) as StudioStreamDoneEvent<TArtifact>;
    return { ok: res.ok, status: res.status, data: json };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalData: StudioStreamDoneEvent<TArtifact> = {};
  let sawError = false;
  let errorStatus = res.status || 500;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          const evt = JSON.parse(line) as {
            type?: string;
            percent?: number;
            label?: string;
            artifact?: TArtifact;
            autoPublishedFirst?: boolean;
            usedAi?: boolean;
            error?: string;
            code?: string;
            status?: number;
          };
          if (evt.type === "progress") {
            onProgress?.(
              typeof evt.percent === "number" ? evt.percent : 0,
              evt.label || "Traitement en cours..."
            );
          } else if (evt.type === "done") {
            finalData = {
              artifact: evt.artifact,
              autoPublishedFirst: evt.autoPublishedFirst,
              usedAi: evt.usedAi,
            };
          } else if (evt.type === "error") {
            sawError = true;
            errorStatus = evt.status || 500;
            finalData = {
              error: evt.error || "Erreur lors de la génération.",
              code: evt.code,
              status: evt.status,
            };
          }
        } catch {
          // Ignore malformed partial NDJSON lines
        }
      }
      nl = buffer.indexOf("\n");
    }
  }

  const ok = !sawError && Boolean(finalData.artifact);
  return {
    ok,
    status: ok ? 201 : errorStatus,
    data: finalData,
  };
}
