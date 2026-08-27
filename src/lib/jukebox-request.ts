// Johnny Outlaw, LLC — Suffering Jukebox — request plumbing shared by the
// Interactive Jukebox routes: rate limiting, guest cookie handling, and the
// "which room is this, and who is asking" resolution every route starts with.

import { NextRequest, NextResponse } from "next/server";
import { normalizeRoomKey } from "@/lib/jukebox";
import { getAuthUser } from "@/lib/sj-admin-auth";
import {
  getGuestByToken,
  getJukeboxByKey,
  guestCookieName,
  sjb,
  type GuestRow,
  type JukeboxRow,
  type ServiceClient,
} from "@/lib/jukebox-db";

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

// Best-effort per-instance throttle, the same shape the comment route uses.
// Buckets are keyed by action so a burst of polling cannot lock out adds.
const buckets = new Map<string, number[]>();

export function rateLimited(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
    }
  }
  return recent.length > max;
}

export const bad = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export const tooMany = () =>
  NextResponse.json({ ok: false, error: "Slow down a moment." }, { status: 429 });

/** Guest cookie lives for a month; a bar regular should not re-join weekly. */
export const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function setGuestCookie(res: NextResponse, code: string, rawToken: string) {
  res.cookies.set(guestCookieName(code), rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE,
  });
}

export function readGuestCookie(req: NextRequest, code: string): string | null {
  return req.cookies.get(guestCookieName(code))?.value ?? null;
}

export type RoomContext = {
  sb: ServiceClient;
  jukebox: JukeboxRow;
  guest: GuestRow | null;
};

/**
 * Resolve the room from a code and the caller from their cookie. Returns a
 * NextResponse instead when the request cannot be served, so routes can do
 * `if ("error" in ctx) return ctx.error`.
 */
export async function resolveRoom(
  req: NextRequest,
  rawCode: unknown,
): Promise<RoomContext | { error: NextResponse }> {
  if (typeof rawCode !== "string") return { error: bad("Missing jukebox code.") };
  // A code or a vanity slug: whatever was in the address bar. Which one it is
  // gets settled against the database, not against the shape of the string.
  const key = normalizeRoomKey(rawCode);
  if (!key) return { error: bad("That jukebox address does not look right.") };

  const sb = sjb();
  const jukebox = await getJukeboxByKey(sb, key);
  if (!jukebox) return { error: bad("No jukebox at that address.", 404) };

  const token = readGuestCookie(req, jukebox.code);
  const guest = await getGuestByToken(sb, token, jukebox.id);
  return { sb, jukebox, guest };
}

/**
 * True when the caller proved, with a real access token, that they own this
 * room. The email never comes from the request body — that would let any guest
 * claim the owner's powers by typing their address.
 */
export async function isOwnerRequest(req: NextRequest, jukebox: JukeboxRow): Promise<boolean> {
  const user = await getAuthUser(req).catch(() => null);
  if (!user?.email) return false;
  return user.email.toLowerCase() === jukebox.owner_email.toLowerCase();
}

/** What the client is allowed to know about the room it just joined. */
export function publicJukebox(jukebox: JukeboxRow) {
  return {
    code: jukebox.code,
    slug: jukebox.public_slug,
    name: jukebox.name,
    isLive: jukebox.is_live,
    settings: jukebox.settings,
    playback: jukebox.playback,
    // How many songs the last broadcast running order holds. Free to send -
    // the row is already loaded - and it is what lets a quiet station offer
    // its playlist without the page having to go and ask for it first.
    lastPlaylistCount: jukebox.last_queue.length,
  };
}

export function publicGuest(guest: GuestRow | null) {
  if (!guest) return null;
  return { id: guest.id, displayName: guest.display_name, isBanned: guest.is_banned };
}
