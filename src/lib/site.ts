// Compatibility shim. The brand now lives in surface.ts, which knows about
// both Suffering Jukebox and Listening Party; these constants are the serving
// surface's values, so the eleven modules that already import SITE_NAME and
// SITE_URL keep working and follow the brand automatically.
//
// New code should call currentSurface() instead, which can also be handed a
// request host. These constants resolve from SURFACE_ID alone and therefore
// fall back to Suffering Jukebox on a preview host with no env var set.

import { currentSurface } from "@/lib/surface";

const surface = currentSurface();

/** Canonical production URL (www redirects from apex in Vercel). */
export const SITE_URL = surface.url;

export const SITE_NAME = surface.name;

export const SITE_DESCRIPTION = surface.description;
