import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = new Set(["/login", "/register", "/robots.txt"]);

function hasAuthSessionCookie(req: NextRequest): boolean {
  return req.cookies
    .getAll()
    .some(
      (c) =>
        /^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/.test(
          c.name
        ) && c.value.trim().length > 10
    );
}

function applyPrivacyHeaders(res: NextResponse): NextResponse {
  res.headers.set(
    "X-Robots-Tag",
    "noindex, nofollow, noarchive, nosnippet, noimageindex"
  );
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith("/api/auth")) {
    return applyPrivacyHeaders(NextResponse.next());
  }

  const isAuthenticated = hasAuthSessionCookie(req);

  if (!isAuthenticated) {
    if (pathname.startsWith("/api/")) {
      return applyPrivacyHeaders(
        NextResponse.json(
          { error: "Authentification requise." },
          { status: 401 }
        )
      );
    }

    const loginUrl = new URL("/login", req.url);
    return applyPrivacyHeaders(NextResponse.redirect(loginUrl, 307));
  }

  return applyPrivacyHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt).*)",
  ],
};
