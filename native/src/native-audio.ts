import { registerPlugin } from '@capacitor/core';

/**
 * The native audio engine.
 *
 * Everything the OS media pipeline owns lives behind this interface: playback
 * of locker files, offline downloads, the lock screen, CarPlay and Android
 * Auto. The web UI keeps the catalog, rooms, lyrics and YouTube playback; it
 * hands a queue to this plugin and then only listens for state.
 *
 * Only locker tracks (a file the signed-in user uploaded to jukebox-audio)
 * can go through here. YouTube-backed tracks have no file to hand the OS, so
 * they never reach the native engine, never appear in CarPlay, and cannot be
 * downloaded.
 */
export interface SJTrack {
  /** jukebox.tracks.id */
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** Remote artwork URL; cached natively on first use. */
  artworkUrl?: string;
  /**
   * A signed URL for the track's file in jukebox-audio. Signed URLs expire,
   * so the web layer refreshes them - the engine asks for a new queue rather
   * than holding a stale URL. Ignored when the track is downloaded.
   */
  url?: string;
  durationSeconds?: number;
}

export type SJPlaybackState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended';

export interface SJStatus {
  state: SJPlaybackState;
  /** Index into the queue last set with setQueue, or -1. */
  index: number;
  trackId: string | null;
  positionSeconds: number;
  durationSeconds: number;
}

export type SJDownloadState = 'none' | 'downloading' | 'done' | 'failed';

export interface SJDownload {
  trackId: string;
  state: SJDownloadState;
  /** 0..1 while downloading. */
  progress: number;
  bytes: number;
  error?: string;
}

export interface SJNativeAudioPlugin {
  /**
   * Replace the queue. Safe to call while playing: if the currently playing
   * track is still present the engine keeps playing it and just re-indexes,
   * which is what makes signed-URL refresh invisible to the listener.
   */
  setQueue(options: { tracks: SJTrack[]; startIndex?: number; autoPlay?: boolean }): Promise<SJStatus>;

  play(options?: { index?: number }): Promise<SJStatus>;
  pause(): Promise<SJStatus>;
  next(): Promise<SJStatus>;
  previous(): Promise<SJStatus>;
  seek(options: { positionSeconds: number }): Promise<SJStatus>;
  getStatus(): Promise<SJStatus>;

  /** Persist a track for offline play. Resolves when the download is queued. */
  download(options: { track: SJTrack }): Promise<SJDownload>;
  removeDownload(options: { trackId: string }): Promise<void>;
  listDownloads(): Promise<{ downloads: SJDownload[]; bytesUsed: number }>;

  addListener(
    event: 'statusChange',
    fn: (status: SJStatus) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: 'downloadChange',
    fn: (download: SJDownload) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  /**
   * Fired when playback was started from outside the web UI - CarPlay, the
   * lock screen, a headset button - so the UI can catch up.
   */
  addListener(
    event: 'remoteCommand',
    fn: (info: { command: string; trackId: string | null }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const SJNativeAudio = registerPlugin<SJNativeAudioPlugin>('SJNativeAudio');

/** True inside the Capacitor shell; false on the web, where this is all absent. */
export const isNative = (): boolean =>
  typeof window !== 'undefined' && (window as unknown as { __SJ_NATIVE__?: boolean }).__SJ_NATIVE__ === true;
