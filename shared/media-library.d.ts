export interface MediaUsage {
  id: string;
  type: 'source' | 'presentation' | 'background' | 'program' | 'output' | 'routing' | 'clip' | 'export' | 'music';
  label: string;
  detail: string;
  href: string;
  live?: boolean;
}

export interface MediaLibraryAsset {
  id: string;
  kind: 'image' | 'video' | 'audio';
  name: string;
  displayName: string;
  url: string;
  thumbnail: string | null;
  bytes: number;
  modifiedAt: string;
  origin: 'library' | 'clip';
  usageStatus: 'known' | 'unavailable';
  usage: MediaUsage[];
  width?: number;
  height?: number;
  durationMs?: number;
  /** Raw station storage references, omitted for private Clip imports. */
  libraryPath?: string;
  playbackPath?: string;
  playbackUrl?: string;
  preparation?: 'processing' | 'ready' | 'failed' | 'missing';
}

export interface MediaLibraryResponse {
  assets: MediaLibraryAsset[];
  warning?: string;
}

export interface MediaDeleteResult {
  deleted: string[];
  blocked: Array<{ id: string; error: string; usage: MediaUsage[] }>;
}
