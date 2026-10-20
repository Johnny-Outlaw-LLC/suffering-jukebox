/**
 * Record Keeper for the desktop (native/recordkeeper/desktop). The installers
 * are GitHub release assets on this public repository, tagged
 * `rk-desktop-v<version>`. Publishing a new one means a new release AND
 * bumping that platform's entry here, which is what /api/desktop-download
 * sends people to.
 *
 * Each platform names its own version: the Windows installer is built on
 * Windows and the Mac dmg on a Mac, so one can ship before the other is
 * rebuilt. `version` is the newest of them, the one the shell's package.json
 * is at.
 *
 * Deliberately a constant rather than a lookup against the GitHub API: the
 * unauthenticated API allows 60 requests an hour per IP, and Vercel's
 * functions share their IPs, so a lookup would start failing exactly when the
 * download link got popular.
 */
export const DESKTOP_APP = {
  version: "1.0.3",
  repo: "Johnny-Outlaw-LLC/suffering-jukebox",
  /** Installer by platform; null until that build is published. */
  builds: {
    windows: { version: "1.0.2", file: "Record-Keeper-Setup-1.0.2.exe" } as DesktopBuild | null,
    mac: { version: "1.0.3", file: "Record-Keeper-1.0.3.dmg" } as DesktopBuild | null,
  },
} as const;

export type DesktopBuild = { version: string; file: string };
export type DesktopPlatform = keyof typeof DESKTOP_APP.builds;

export function desktopTag(version: string = DESKTOP_APP.version): string {
  return `rk-desktop-v${version}`;
}

/** Where to download the installer for a platform, or null if there is none yet. */
export function desktopDownloadUrl(platform: string): string | null {
  if (platform !== "windows" && platform !== "mac") return null;
  const build = DESKTOP_APP.builds[platform];
  if (!build) return null;
  return `https://github.com/${DESKTOP_APP.repo}/releases/download/${desktopTag(build.version)}/${build.file}`;
}

/** The platform to offer when the link names none: the Mac to a Mac, Windows to everyone else. */
export function desktopPlatformFor(userAgent: string | null | undefined): DesktopPlatform {
  return /Macintosh|Mac OS X/i.test(userAgent || "") ? "mac" : "windows";
}
