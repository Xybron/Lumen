/** Portable station content; account credentials and live output state are excluded. */
export interface TransferItem {
  id: string;
  name: string;
  detail?: string;
  bytes?: number;
  exists?: boolean;
  blockedReason?: string;
}

export interface TransferCatalog {
  bibles: TransferItem[];
  songs: TransferItem[];
  presentations: TransferItem[];
  media: TransferItem[];
  scenes: TransferItem[];
  recordings: TransferItem[];
  setlists: TransferItem[];
  clips: TransferItem[];
  settings: boolean;
}

export interface TransferSelection {
  bibles: string[];
  songs: string[];
  presentations: string[];
  media: string[];
  scenes: string[];
  recordings: string[];
  setlists: string[];
  clips: string[];
  settings: boolean;
}

export interface TransferPreview {
  token: string;
  createdAt: string;
  expiresAt: string;
  catalog: TransferCatalog;
  warnings: string[];
}

export interface TransferCounts {
  bibles: number;
  songs: number;
  presentations: number;
  media: number;
  scenes: number;
  recordings: number;
  setlists: number;
  clips: number;
  settings: number;
}

export interface TransferResult {
  imported: TransferCounts;
  skipped: TransferCounts;
  backupPath: string;
  warnings: string[];
}

export interface ClearPreview {
  token: string;
  expiresAt: string;
  selection: TransferSelection;
  counts: TransferCounts;
  warnings: string[];
  blockers: string[];
}

export interface ClearResult {
  removed: TransferCounts;
  backupPath: string;
  warnings: string[];
}
