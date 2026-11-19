export type PresentationDocumentKind = 'pdf' | 'powerpoint';
export interface PresentationDocumentPage { page: number; width: number; height: number; previewUrl: string }
export interface PresentationDocumentJob {
  id: string; sourceName: string; sourceType: PresentationDocumentKind;
  state: 'converting' | 'rendering' | 'ready' | 'error';
  completedPages: number; totalPages: number; pages: PresentationDocumentPage[]; error?: string;
}
export interface PresentationDocumentImport {
  sourceId: string; sourceName: string; sourceType: PresentationDocumentKind; totalPages: number;
  pages: Array<{ page: number; title: string; path: string; width: number; height: number }>;
}
