// YITOKEN changes: narrow JSON contract for local full-film rendering.
// AGPL-3.0-or-later; derived application's notices are in NOTICE.md.
export type FilmRenderPhase = 'queued' | 'downloading' | 'probing' | 'normalizing' | 'concatenating' | 'validating' | 'completed' | 'cancelled' | 'failed';
export type FilmRenderClip = { id: string; mediaId?: string; name: string; sourceUrl: string };
export type FilmRenderRequest = {
  projectId: string;
  projectName: string;
  aspectRatio: '16:9' | '9:16';
  resolution: '720p' | '1080p';
  clips: FilmRenderClip[];
};
export type FilmRenderStatus = {
  jobId: string;
  projectId: string;
  projectName: string;
  phase: FilmRenderPhase;
  progress: number;
  processedClips: number;
  totalClips: number;
  currentClip?: string;
  outputPath?: string;
  error?: string;
};
export type FilmRenderResult = { success: boolean; job?: FilmRenderStatus; cancelled?: boolean; error?: string };
export type FilmRenderActionResult = { success: boolean; error?: string };
export type FilmRendererBridge = {
  start: (request: FilmRenderRequest) => Promise<FilmRenderResult>;
  status: (jobId: string) => Promise<FilmRenderResult>;
  cancel: (jobId: string) => Promise<FilmRenderActionResult>;
  reveal: (jobId: string) => Promise<FilmRenderActionResult>;
};
