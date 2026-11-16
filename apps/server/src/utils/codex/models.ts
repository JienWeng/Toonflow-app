import { z } from "zod";
import conf from "@/utils/conf";
import { modelGateway, requireDirectModelAccess } from "@/utils/multiTenant/gateway";
import { CodexClient } from "./client";
import { thinkingLevels, type ThinkingLevel } from "@/lib/modelReasoning";

export const localCodexProviderId = "localCodex";
export function localCodexSettings() {
  const data = z.object({ enabled: z.boolean().default(true), executable: z.string().trim().min(1).max(4096).default("codex") })
    .safeParse(conf.get("settings", {}).localCodex ?? {});
  if (!data.success) throw new Error("本地 Codex 配置无效");
  return data.data;
}

const modelSchema = z.object({
  id: z.string(), model: z.string().min(1), displayName: z.string(), hidden: z.boolean().optional(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).default([]),
});
export type LocalCodexModel = { id: string; label: string; reasoningLevels: ThinkingLevel[] };
type LocalCodexStatus = { available: boolean; authenticated: boolean; message: string; models: LocalCodexModel[] };
let cached: { executable: string; expires: number; value: LocalCodexStatus } | undefined;
let loading: { executable: string; value: Promise<LocalCodexStatus> } | undefined;

export async function codexStatus(fresh = false): Promise<LocalCodexStatus> {
  requireDirectModelAccess();
  const settings = localCodexSettings();
  if (!settings.enabled) return { available: false, authenticated: false, message: "Local Codex is disabled", models: [] };
  if (!fresh && cached?.executable === settings.executable && cached.expires > Date.now()) return cached.value;
  if (loading?.executable === settings.executable) return loading.value;
  const connection = new CodexClient(settings.executable);
  const value = (async () => {
    let available = false;
    let authenticated = false;
    try {
      await connection.initialize();
      available = true;
      const account = await connection.request<{ account: unknown }>("account/read", { refreshToken: false });
      authenticated = !!account.account;
      if (!authenticated) return { available, authenticated, message: "Run codex login on the machine running Toonflow, then refresh the connection", models: [] };
      const models: LocalCodexModel[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = z.object({ data: z.array(modelSchema), nextCursor: z.string().nullable().optional() })
          .parse(await connection.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }));
        for (const model of page.data.filter(item => !item.hidden)) models.push({
          id: model.model, label: model.displayName,
          reasoningLevels: thinkingLevels.filter(level => model.supportedReasoningEfforts.some(item => item.reasoningEffort === level)),
        });
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Codex 模型列表分页无效");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { available, authenticated, message: "Connected using your local Codex login", models };
    } catch (cause) {
      return { available, authenticated, message: cause instanceof Error ? cause.message : "本地 Codex 不可用", models: [] };
    } finally { connection.stop(); }
  })();
  loading = { executable: settings.executable, value };
  try {
    const status = await value;
    cached = { executable: settings.executable, expires: Date.now() + 60000, value: status };
    return status;
  } finally { if (loading?.value === value) loading = undefined; }
}

export async function listLocalCodexModels() {
  if (modelGateway.enabled()) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: LocalCodexStatus | undefined;
  try {
    // 模型目录也用于启动与 API 供应商；慢 CLI 探测留在后台，不阻断应用初始化。
    status = await Promise.race([codexStatus().catch(() => undefined), new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), 1500);
    })]);
  } finally { clearTimeout(timer); }
  return (status?.models ?? []).map(model => ({
    providerId: localCodexProviderId, providerLabel: "Local Codex", protocol: "local-codex",
    modelId: model.id, label: model.label, contextWindow: 0, maxOutputTokens: 0, reasoningLevels: model.reasoningLevels,
  }));
}
