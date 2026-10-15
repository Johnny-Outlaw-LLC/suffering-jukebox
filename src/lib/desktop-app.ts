/**
 * Record Keeper for the desktop (native/recordkeeper/desktop). The installers
 * are GitHub release assets on this public repository, tagged
 * `rk-desktop-v<version>`. Publishing a new one means a new release AND
 * bumping `version` here, which is what /api/desktop-download sends people to.
 *
 * Deliberately a constant rather than a lookup against the GitHub API: the
 * unauthenticated API allows 60 requests an hour per IP, and Vercel's
 * functions share their IPs, so a lookup would start failing exactly when the
 * download link got popular.
 */
export const DESKTOP_APP = {
  version: "1.0.0",
  repo: "Johnny-Outlaw-LLC/suffering-jukebox",
  /** Installer file names by platform; null until that build is published. */
  files: {
    windows: "Record-Keeper-Setup-1.0.0.exe",
    mac: null as string | null,
  },
} as const;

export type DesktopPlatform = keyof typeof DESKTOP_APP.files;

export function desktopTag(version: string = DESKTOP_APP.version): string {
  return `rk-desktop-v${version}`;
}

/** Where to download the installer for a platform, or null if there is none yet. */
export function desktopDownloadUrl(platform: string): string | null {
  if (platform !== "windows" && platform !== "mac") return null;
  const file = DESKTOP_APP.files[platform];
  if (!file) return null;
  return `https://github.com/${DESKTOP_APP.repo}/releases/download/${desktopTag()}/${file}`;
}
