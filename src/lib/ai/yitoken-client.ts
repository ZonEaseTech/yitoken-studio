// Copyright (c) 2026 YITOKEN Studio contributors
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
/** Declared YITOKEN protocols; no billable submission is automatically retried. */
export const YITOKEN_ROOT = 'https://yitoken.com.cn';
export const YITOKEN_RECOMMENDED_MODELS = ['gpt-6.1-sol', 'seedream-5.0-lite', 'seedance-2.0-mini'];
export const YITOKEN_DEFAULT_ENDPOINTS: Record<string, string[]> = {
  'gpt-6.1-sol': ['openai'], 'seedream-5.0-lite': ['image-generation'], 'seedance-2.0-mini': ['openai-video'],
};
export const YITOKEN_DEFAULT_MODELS: Record<string, string> = {
  script_analysis: 'gpt-6.1-sol', chat: 'gpt-6.1-sol',
  character_generation: 'seedream-5.0-lite', scene_generation: 'seedream-5.0-lite', freedom_image: 'seedream-5.0-lite',
  video_generation: 'seedance-2.0-mini', freedom_video: 'seedance-2.0-mini',
};
export function normalizeYitokenRoot(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('YITOKEN Base URL 必须是无凭证、查询参数的 HTTPS 根地址（可带 /v1）');
  }
  return url.origin;
}
export async function syncYitokenModels(baseUrl: string, apiKey: string): Promise<{ models: string[]; endpoints: Record<string, string[]> }> {
  if (!apiKey.trim()) throw new Error('请先配置您自己的 API Key');
  const root = normalizeYitokenRoot(baseUrl);
  const response = await fetch(`${root}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`模型列表请求失败 (${response.status})`);
  const list = await response.json();
  if (!Array.isArray(list.data)) throw new Error('模型列表响应格式不正确');
  const models: string[] = [];
  const endpoints: Record<string, string[]> = {};
  for (const entry of list.data) {
    if (typeof entry?.id !== 'string' || !entry.id.trim()) continue;
    if (!models.includes(entry.id)) models.push(entry.id);
    if (Array.isArray(entry.supported_endpoint_types)) endpoints[entry.id] = entry.supported_endpoint_types.filter((e: unknown) => typeof e === 'string');
  }
  // Pricing is public discovery only. Never grant access to a model absent from /v1/models.
  try {
    const pricing = await fetch(`${root}/api/pricing`);
    if (pricing.ok) {
      const metadata = await pricing.json();
      for (const entry of Array.isArray(metadata.data) ? metadata.data : []) {
        if (models.includes(entry.model_name) && Array.isArray(entry.supported_endpoint_types)) endpoints[entry.model_name] = entry.supported_endpoint_types.filter((e: unknown) => typeof e === 'string');
      }
    }
  } catch { /* Model listing remains usable; unknown protocols remain unavailable. */ }
  return { models, endpoints };
}
export function supportsYitokenFeature(feature: string, model: string, endpoints: Record<string, string[]>): boolean {
  const types = endpoints[model] || [];
  if (['video_generation', 'freedom_video'].includes(feature)) return types.includes('openai-video') && /^seedance-2\.(0|5)(?:-(?:mini|fast))?$/.test(model);
  if (['character_generation', 'scene_generation', 'freedom_image'].includes(feature)) return types.includes('image-generation') && /^seedream-5\.0-(lite|pro)$/.test(model);
  if (feature === 'image_understanding') return false; // No verified vision contract in this first version.
  return types.includes('openai') && !types.includes('openai-video') && !types.includes('image-generation');
}
/** Once a POST may have reached the server, no outer key rotation may resubmit it. */
export class YitokenSubmissionError extends Error {
  readonly submissionAttempted = true;
  readonly retrySafe = false;
  readonly status?: number;
  readonly taskId?: string;
  constructor(message: string, details: { status?: number; taskId?: string } = {}) {
    super(message);
    this.name = 'YitokenSubmissionError';
    this.status = details.status;
    this.taskId = details.taskId;
  }
}
interface YitokenRequest { baseUrl: string; apiKey: string; model: string; prompt: string; signal?: AbortSignal }
export interface YitokenVideoRequest extends YitokenRequest {
  duration?: number; aspectRatio?: string; resolution?: string;
  images?: Array<{ url: string; role: 'first_frame' | 'last_frame' | 'reference_image' }>;
  videoRefs?: string[]; audioRefs?: string[]; enableAudio?: boolean; cameraFixed?: boolean;
  onProgress?: (progress: number) => void;
}
function requireReferenceUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('参考素材必须先由您授权上传到 HTTPS 存储；不支持自动游客上传'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('参考素材必须先由您授权上传到 HTTPS 存储；不支持自动游客上传');
  return value;
}
export function isYitokenRequest(baseUrl: string, platform?: string): boolean {
  if (platform === 'yitoken') return true;
  try { return ['yitoken.com.cn', 'www.yitoken.com.cn'].includes(new URL(baseUrl).hostname); } catch { return false; }
}

async function submitOnce(url: string, params: YitokenRequest, body: unknown): Promise<any> {
  if (params.signal?.aborted) throw new Error('用户已取消，未提交生成任务');
  if (!params.prompt.trim()) throw new Error('请输入生成提示词');
  if (!params.apiKey.trim()) throw new Error('请先配置您自己的 API Key');
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.apiKey}` }, body: JSON.stringify(body), signal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
  } catch { throw new YitokenSubmissionError('提交结果未知，可能已计费。请先在 YITOKEN 后台核对任务，不要重复提交。'); }
  if (!response.ok) throw new YitokenSubmissionError(`提交失败 (${response.status})，请核对后台任务后再操作；不会自动重复提交。`, { status: response.status });
  try { return await response.json(); } catch { throw new YitokenSubmissionError('提交响应无法解析，可能已计费。请核对后台任务，不要重复提交。'); }
}
export async function generateYitokenVideo(params: YitokenVideoRequest, options: { pollInterval?: number; maxPollAttempts?: number } = {}): Promise<{ url: string; taskId: string }> {
  const root = normalizeYitokenRoot(params.baseUrl);
  if (!/^seedance-2\.(0|5)(?:-(?:mini|fast))?$/.test(params.model)) throw new Error('此视频模型的 YITOKEN 协议尚未适配');
  const duration = params.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error('当前版本的视频时长只支持 4–15 秒');
  const ratio = params.aspectRatio || '16:9';
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'].includes(ratio)) throw new Error('当前视频比例尚未适配');
  const resolution = params.resolution?.toLowerCase() || '720p';
  if (!['480p', '720p', '1080p'].includes(resolution)) throw new Error('当前视频分辨率尚未适配');
  const content: unknown[] = (params.images || []).map(image => ({ type: 'image_url', image_url: { url: requireReferenceUrl(image.url) }, role: image.role }));
  for (const url of params.videoRefs || []) content.push({ type: 'video_url', video_url: { url: requireReferenceUrl(url) }, role: 'reference_video' });
  for (const url of params.audioRefs || []) content.push({ type: 'audio_url', audio_url: { url: requireReferenceUrl(url) }, role: 'reference_audio' });
  const metadata = { ratio, resolution, content, ...(params.enableAudio !== undefined ? {generate_audio: params.enableAudio} : {}), ...(params.cameraFixed !== undefined ? {camera_fixed: params.cameraFixed} : {}) };
  const submitted = await submitOnce(`${root}/v1/videos`, params, { model: params.model, prompt: params.prompt, seconds: String(duration), metadata });
  const taskId = submitted.id;
  if (typeof taskId !== 'string' || !taskId) throw new YitokenSubmissionError('提交未返回任务 ID，可能已计费，请核对后台任务，不要重复提交');
  const max = Math.min(300, Math.max(1, options.maxPollAttempts ?? 150));
  for (let attempt = 0; attempt < max; attempt++) {
    if (params.signal?.aborted) throw new YitokenSubmissionError(`已停止查询，任务 ${taskId} 可能仍在后台执行，请勿重复提交`, { taskId });
    await new Promise(resolve => setTimeout(resolve, options.pollInterval ?? 2000));
    let response: Response;
    try { response = await fetch(`${root}/v1/videos/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${params.apiKey}` }, signal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) }); }
    catch { continue; }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new YitokenSubmissionError(`查询授权失败 (${response.status})，任务 ${taskId} 不会重新提交`, { taskId, status: response.status });
      continue;
    }
    let task: any;
    try { task = await response.json(); } catch { continue; }
    const progress = Number(String(task.progress ?? '').replace('%', ''));
    if (Number.isFinite(progress)) params.onProgress?.(Math.max(0, Math.min(100, progress)));
    const status = String(task.status || '').toLowerCase();
    if (['failed', 'failure', 'error', 'cancelled', 'expired'].includes(status)) throw new YitokenSubmissionError(`视频任务 ${taskId} 失败，请查看 YITOKEN 后台详情`, { taskId });
    if (['completed', 'succeeded', 'success'].includes(status)) {
      const url = task.url || task.video_url || task.content?.video_url || task.data?.url;
      if (typeof url !== 'string' || !url) throw new YitokenSubmissionError(`视频任务 ${taskId} 完成但没有可下载地址，请到后台查询；不会重新提交`, { taskId });
      requireReferenceUrl(url);
      params.onProgress?.(100);
      return { url, taskId };
    }
  }
  throw new YitokenSubmissionError(`查询超时，任务 ${taskId} 可能仍在执行。请到 YITOKEN 后台查询，不要重复提交。`, { taskId });
}
export async function generateYitokenImage(params: YitokenRequest & { size?: string; referenceImages?: string[]; negativePrompt?: string }): Promise<{ imageUrl: string }> {
  const root = normalizeYitokenRoot(params.baseUrl);
  if (!/^seedream-5\.0-(lite|pro)$/.test(params.model)) throw new Error('此图片模型的 YITOKEN 协议尚未适配');
  const size = params.size || '2048x2048';
  const dimensions = /^(\d+)x(\d+)$/.exec(size);
  const width = dimensions ? Number(dimensions[1]) : 0;
  const height = dimensions ? Number(dimensions[2]) : 0;
  if (width < 512 || height < 512 || width > 8192 || height > 8192 || width * height > 4096 * 4096 * 1.01 || width * height < 2048 * 2048 * 0.99) throw new Error('当前 Seedream 图片尺寸只支持 2K–4K 像素面积，请调整分辨率与比例');
  const image = (params.referenceImages || []).map(requireReferenceUrl);
  // Seedream compatibility: textual exclusions are not a native negative_prompt parameter.
  // Keep original params for submitOnce so exclusions cannot make a blank positive prompt billable.
  const exclusions = params.negativePrompt?.trim();
  const prompt = exclusions ? `${params.prompt}\n\nAvoid these visual elements: ${exclusions}` : params.prompt;
  const data = await submitOnce(`${root}/v1/images/generations`, params, { model: params.model, prompt, n: 1, size, response_format: 'url', ...(image.length ? { image } : {}) });
  const item = data.data?.[0];
  if (item?.url) return { imageUrl: requireReferenceUrl(item.url) };
  if (item?.b64_json) return { imageUrl: `data:image/png;base64,${item.b64_json}` };
  throw new YitokenSubmissionError('图片响应没有可用图片，可能已计费，请核对后台，不要重复提交');
}

export async function generateYitokenChat(params: YitokenRequest & { systemPrompt: string; temperature?: number; maxTokens?: number }): Promise<string> {
  const root = normalizeYitokenRoot(params.baseUrl);
  const maxTokens = params.maxTokens ?? 4096;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072) throw new Error('对话输出 token 数不在本版支持范围');
  const data = await submitOnce(`${root}/v1/chat/completions`, params, { model: params.model, messages: [{ role: 'system', content: params.systemPrompt }, { role: 'user', content: params.prompt }], temperature: params.temperature ?? 0.7, max_tokens: maxTokens });
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new YitokenSubmissionError('对话已返回但没有可用正文（可能仅有 reasoning），可能已计费。请选择兼容模型并核对后台，不会自动重复请求。');
  return content;
}
export function canAutomaticallyResubmitGeneration(platform: string, error?: unknown): boolean {
  return platform !== 'yitoken' && (error as { retrySafe?: boolean } | undefined)?.retrySafe !== false;
}
