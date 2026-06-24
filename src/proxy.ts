import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const navRef = request.headers.get("referer") || request.headers.get("referrer");
  if (navRef && request.method === "GET" && !request.nextUrl.pathname.startsWith("/api")) {
    response.cookies.set("sj_nav_referrer", navRef, {
      maxAge: 180,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
