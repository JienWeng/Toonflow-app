const rules = [{
  type: "input", field: "apiKey" as const, title: "fal.ai API Key", value: "",
  props: { type: "password", showPassword: true, autocomplete: "off" },
}] as const;

type FalContext = ProviderContext<{ apiKey: string }>;
const imageModel = "fal-ai/flux/schnell";
const videoModel = "fal-ai/veo3.1/fast";
const imageVideoModel = `${videoModel}/image-to-video`;
const imageSizes: Record<string, string> = {
  "1:1": "square_hd", "4:3": "landscape_4_3", "3:4": "portrait_4_3",
  "16:9": "landscape_16_9", "9:16": "portrait_16_9",
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fal.ai 返回了无效响应");
  return value as Record<string, unknown>;
}

function key(context: FalContext) {
  const value = context.config.apiKey?.trim();
  if (!value) throw new Error("请在媒体模型设置中填写 fal.ai API Key");
  return value;
}

function taskUrl(value: unknown, model: string, requestId: string, suffix = "") {
  if (typeof value !== "string") throw new Error("fal.ai 未返回任务地址");
  const url = new URL(value);
  const app = model.split("/").slice(0, 2).join("/");
  if (url.origin !== "https://queue.fal.run" || url.username || url.password || url.search || url.hash
    || url.pathname !== `/${app}/requests/${encodeURIComponent(requestId)}${suffix}`) {
    throw new Error("fal.ai 任务地址无效");
  }
  return url.href;
}

async function request(context: FalContext, url: string, signal: AbortSignal, body?: Record<string, unknown>) {
  const response = await context.tool.fetch(url, {
    method: body ? "POST" : "GET", redirect: "error", signal,
    headers: { Authorization: `Key ${key(context)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const terminal = !body && [400, 422].includes(response.status);
    throw Object.assign(new Error(`fal.ai 请求失败（HTTP ${response.status}）`), terminal ? { code: "MEDIA_TASK_FAILED" } : {});
  }
  return object(await response.json());
}

function signalFor(context: FalContext) {
  return AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(context.signal ? [context.signal] : [])]);
}

async function pause(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function recovery(data: ProviderTaskData) {
  if (![imageModel, videoModel, imageVideoModel].includes(String(data.model))
    || typeof data.requestId !== "string" || !/^[\w-]{1,128}$/.test(data.requestId)
    || data.kind !== (data.model === imageModel ? "image" : "video")) throw new Error("fal.ai 任务恢复数据无效");
  const model = String(data.model);
  return {
    kind: data.kind as "image" | "video", model, requestId: data.requestId,
    statusUrl: taskUrl(data.statusUrl, model, data.requestId, "/status"),
    responseUrl: taskUrl(data.responseUrl, model, data.requestId),
  };
}

async function poll(context: FalContext, data: ProviderTaskData, signal: AbortSignal): Promise<MediaAsset[]> {
  const task = recovery(data);
  while (true) {
    signal.throwIfAborted();
    const status = await request(context, task.statusUrl, signal);
    if (status.status === "COMPLETED") {
      if (status.error) throw Object.assign(new Error("fal.ai 媒体生成失败，请在 fal.ai 控制台查看任务"), { code: "MEDIA_TASK_FAILED" });
      const result = await request(context, task.responseUrl, signal);
      const files = task.kind === "image" ? result.images : [result.video];
      if (!Array.isArray(files) || !files.length) throw new Error("fal.ai 未返回媒体文件");
      return files.map(item => {
        const file = object(item);
        if (typeof file.url !== "string" || !/^https:\/\//i.test(file.url)) throw new Error("fal.ai 返回了无效媒体地址");
        return { type: "url", mediaType: task.kind, url: file.url,
          ...(typeof file.content_type === "string" ? { mimeType: file.content_type } : {}) };
      });
    }
    if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") throw new Error("fal.ai 返回了未知任务状态");
    await pause(signal);
  }
}

async function submit(context: FalContext, model: string, kind: "image" | "video", input: Record<string, unknown>) {
  key(context);
  const signal = signalFor(context);
  // ACT: 提交不自动重试；接单凭据先保存，再轮询原任务，避免恢复时重复付费。
  const accepted = await request(context, `https://queue.fal.run/${model}`, signal, input);
  const data = recovery({ model, kind, requestId: accepted.request_id as string,
    statusUrl: accepted.status_url as string, responseUrl: accepted.response_url as string });
  await context.saveTaskData?.(data);
  return poll(context, data, signal);
}

function extras(other: Record<string, unknown> | undefined, allowed: string[]) {
  const values = other ?? {};
  if (Object.keys(values).some(name => !allowed.includes(name))) throw new Error("fal.ai 不支持所填写的额外参数");
  if (values.seed !== undefined && (!Number.isSafeInteger(values.seed) || Number(values.seed) < 0)) throw new Error("seed 必须是非负整数");
  if (values.negative_prompt !== undefined && typeof values.negative_prompt !== "string") throw new Error("negative_prompt 必须是文本");
  return values;
}

function mediaUrl(input: MediaInput) {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("参考图须使用 HTTP 或 HTTPS 地址");
    return input.url;
  }
  if (!input.mimeType?.startsWith("image/")) throw new Error("参考素材必须是图片");
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

export default {
  id: "fal", label: "fal.ai", icon: "", version: "1.0.0", rules,
  readme: "Use your own fal.ai API key; no Toonflow account is required. Supports FLUX Schnell images and Veo 3.1 Fast text-to-video and image-to-video. Interrupted tasks can resume the original queue request. Stopping local waiting does not guarantee remote cancellation or a refund. Requests are made by the server.",
  models: [
    { id: "fal-ai/flux/schnell", label: "FLUX Schnell", type: "image", mode: ["text"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
      imageSizes: ["square_hd", "landscape_4_3", "portrait_4_3", "landscape_16_9", "portrait_16_9"] },
    { id: "fal-ai/veo3.1/fast", label: "Veo 3.1 Fast · Text to video", type: "video", mode: ["text"], audio: "optional",
      durationResolutionMap: [{ duration: [4, 6, 8], resolution: ["720p", "1080p"] }] },
    { id: "fal-ai/veo3.1/fast/image-to-video", label: "Veo 3.1 Fast · Image to video", type: "video", mode: ["singleImage"], audio: "optional",
      durationResolutionMap: [{ duration: [4, 6, 8], resolution: ["720p", "1080p"] }] },
  ],
  async generateImage(input: ImageRequest) {
    if (input.model !== imageModel || !input.prompt.trim()) throw new Error("请选择 FLUX Schnell 并填写提示词");
    if (input.images?.length || input.mask || input.quality) throw new Error("FLUX Schnell 仅支持文生图，不支持参考图、蒙版或画质参数");
    const size = input.size ?? (input.ratio ? imageSizes[input.ratio] : undefined);
    if ((input.ratio && !imageSizes[input.ratio]) || (size && !Object.values(imageSizes).includes(size))) throw new Error("FLUX Schnell 不支持所选尺寸或比例");
    if (input.n !== undefined && (!Number.isInteger(input.n) || input.n < 1 || input.n > 4)) throw new Error("单次生成数量须为 1 到 4");
    if (input.outputFormat && !["png", "jpeg"].includes(input.outputFormat)) throw new Error("FLUX Schnell 仅支持 PNG 或 JPEG");
    return submit(this, imageModel, "image", { ...extras(input.other, ["seed"]), prompt: input.prompt,
      ...(size ? { image_size: size } : {}), num_images: input.n ?? 1, output_format: input.outputFormat ?? "jpeg" });
  },
  async generateVideo(input: VideoRequest) {
    const imageMode = input.model === imageVideoModel;
    if ((!imageMode && input.model !== videoModel) || !input.prompt.trim()) throw new Error("请选择 Veo 3.1 Fast 并填写提示词");
    if (input.lastFrame || input.videos?.length || input.audios?.length || input.watermark !== undefined) throw new Error("Veo 3.1 Fast 不支持这些参考素材或水印设置");
    if (input.ratio && !["16:9", "9:16"].includes(input.ratio)) throw new Error("Veo 3.1 Fast 仅支持 16:9 或 9:16");
    if (input.duration !== undefined && ![4, 6, 8].includes(input.duration)) throw new Error("视频时长须为 4、6 或 8 秒");
    if (input.resolution && !["720p", "1080p"].includes(input.resolution)) throw new Error("请选择 720p 或 1080p");
    const images = [...(input.firstFrame ? [input.firstFrame] : []), ...(input.images ?? [])];
    if (imageMode ? images.length !== 1 : images.length !== 0) throw new Error(imageMode ? "图生视频需要且仅支持一张参考图" : "文生视频不支持参考图");
    if (input.mode && input.mode !== (imageMode ? "singleImage" : "text")) throw new Error("生成模式与 fal.ai 模型不匹配");
    return submit(this, input.model, "video", { ...extras(input.other, ["seed", "negative_prompt"]), prompt: input.prompt,
      duration: `${input.duration ?? 8}s`, resolution: input.resolution ?? "720p", aspect_ratio: input.ratio ?? "16:9",
      generate_audio: input.generateAudio ?? true, ...(imageMode ? { image_url: mediaUrl(images[0]!) } : {}) });
  },
  async resumeTask(data: ProviderTaskData) { return poll(this, data, signalFor(this)); },
} satisfies ProviderDefinition<typeof rules>;
