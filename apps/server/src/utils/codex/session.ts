import { createHash } from "node:crypto";
import { z } from "zod";
import { validateToolArguments, type AssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "@/agent/runtime/types";
import type { ThinkingLevel } from "@/lib/modelReasoning";
import { requireDirectModelAccess } from "@/utils/multiTenant/gateway";
import { CodexClient } from "./client";
import { localCodexSettings } from "./models";

export function codexAssistant(model: string, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", api: "openai-responses", provider: "localCodex", model, content, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

const bindingSchema = z.object({ threadId: z.string().min(1), ownerSessionId: z.string().min(1), contextHash: z.string(), toolsHash: z.string(), model: z.string() });
const toolCallSchema = z.object({ threadId: z.string(), callId: z.string().min(1), tool: z.string(), arguments: z.record(z.string(), z.unknown()) });
const itemSchema = z.object({ id: z.string(), type: z.string(), text: z.string().optional() });
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function runCodexSession(options: {
  session: AgentSession; prompt: string; modelId: string; thinkingLevel?: ThinkingLevel; signal: AbortSignal;
  images?: ImageContent[]; forceNewThread?: boolean; send(event: AgentEvent): void; onUserMessage?(id: string): void;
  onToolResult?(id: string, name: string, result: Awaited<ReturnType<AgentSession["agent"]["state"]["tools"][number]["execute"]>>): void;
}) {
  requireDirectModelAccess();
  const { session, prompt, modelId, thinkingLevel, send } = options;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const settings = localCodexSettings();
  if (!settings.enabled) throw new Error("本地 Codex 已关闭");
  const history = session.sessionManager;
  const tools = session.agent.state.tools;
  const dynamicTools = tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters }));
  const toolsHash = hash({ dynamicTools, prompt: session.agent.state.systemPrompt });
  const previous = history.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "localCodexThread");
  const latest = history.getEntries().findLast(entry => entry.type === "custom" && entry.customType === "localCodexThread");
  const binding = bindingSchema.safeParse(previous?.type === "custom" ? previous.data : undefined);
  const messages = history.buildSessionContext().messages;
  const canResume = !options.forceNewThread && binding.success && previous?.id === latest?.id
    && binding.data.ownerSessionId === history.getSessionId() && binding.data.contextHash === hash(messages)
    && binding.data.toolsHash === toolsHash && binding.data.model === modelId;
  const client = new CodexClient(settings.executable, history.getCwd());
  const completed = Promise.withResolvers<void>();
  void completed.promise.catch(() => {});
  const texts: string[] = [];
  const seenItems = new Set<string>();
  let threadId: string | undefined;
  let turnId: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let toolQueue = Promise.resolve();
  const abort = () => {
    if (threadId && turnId) void client.request("turn/interrupt", { threadId, turnId }, 1000).catch(() => {});
    completed.reject(signal.reason ?? new DOMException("生成已停止", "AbortError"));
    client.stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  void client.closed.then(error => completed.reject(error));
  client.onNotification = (method, params) => {
    if (params.threadId !== threadId) return;
    if (method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      turnId = turn?.id;
    }
    if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") {
      if (typeof params.itemId === "string" && typeof params.delta === "string") send({
        type: method === "item/agentMessage/delta" ? "text" : "thinking", blockId: params.itemId, delta: params.delta,
      });
    }
    if (method === "item/completed") {
      const parsed = itemSchema.safeParse(params.item);
      if (parsed.success && parsed.data.type === "agentMessage" && parsed.data.text && !seenItems.has(parsed.data.id)) {
        const item = parsed.data;
        seenItems.add(item.id);
        texts.push(item.text!);
        history.appendMessage(codexAssistant(modelId, [{ type: "text", text: item.text! }]));
        send({ type: "text", blockId: item.id, content: item.text, done: true });
      }
    }
    if (method === "turn/completed") {
      const turn = params.turn as { status?: string; error?: unknown } | undefined;
      if (turn?.status === "completed") completed.resolve();
      else completed.reject(new Error(turn?.status === "interrupted" ? "Codex 回复已停止" : "Codex 回复失败，请检查本地 CLI 与模型权限"));
    }
  };
  client.onRequest = async (method, params) => {
    // 原生命令、文件修改、外部 MCP 等审批请求不自动批准；仅暴露 Toonflow 已配置的工具。
    if (method !== "item/tool/call") throw new Error("不支持此 Codex 操作，请使用 Toonflow 工具");
    const call = toolCallSchema.parse(params);
    if (call.threadId !== threadId) throw new Error("Codex 工具调用不属于当前会话");
    const task = toolQueue.then(async () => {
      signal.throwIfAborted();
      const tool = tools.find(item => item.name === call.tool);
      if (!tool) return { success: false, contentItems: [{ type: "inputText", text: "此工具未授权" }] };
      const toolCall = { type: "toolCall" as const, id: call.callId, name: call.tool, arguments: call.arguments };
      history.appendMessage(codexAssistant(modelId, [toolCall], "toolUse"));
      send({ type: "tool", blockId: call.callId, tool: { id: call.callId, name: call.tool, args: call.arguments, status: "running" } });
      try {
        const args = validateToolArguments(tool, toolCall);
        const result = await tool.execute(call.callId, args, signal, update => send({ type: "tool", blockId: call.callId,
          tool: { id: call.callId, name: call.tool, status: "running", result: update.content.filter(part => part.type === "text").map(part => part.text).join("\n") } }));
        signal.throwIfAborted();
        history.appendMessage({ role: "toolResult", toolCallId: call.callId, toolName: call.tool, content: result.content,
          details: result.details, isError: false, timestamp: Date.now() });
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        send({ type: "tool", blockId: call.callId, tool: { id: call.callId, name: call.tool, result: text, status: "success" } });
        options.onToolResult?.(call.callId, call.tool, result);
        return { success: true, contentItems: result.content.map(part => part.type === "text"
          ? { type: "inputText", text: part.text }
          : { type: "inputImage", imageUrl: `data:${part.mimeType};base64,${part.data}` }) };
      } catch (cause) {
        const text = signal.aborted ? "工具调用已停止" : cause instanceof Error ? cause.message : "工具执行失败";
        history.appendMessage({ role: "toolResult", toolCallId: call.callId, toolName: call.tool,
          content: [{ type: "text", text }], isError: true, timestamp: Date.now() });
        send({ type: "tool", blockId: call.callId, tool: { id: call.callId, name: call.tool, result: text, status: signal.aborted ? "interrupted" : "error" } });
        return { success: false, contentItems: [{ type: "inputText", text }] };
      }
    });
    toolQueue = task.then(() => {}, () => {});
    return task;
  };
  try {
    signal.throwIfAborted();
    await client.initialize();
    const account = await client.request<{ account: unknown }>("account/read", { refreshToken: false });
    if (!account.account) throw new Error("请在 Toonflow 服务所在机器运行 codex login，然后刷新连接");
    const common = { model: modelId, cwd: history.getCwd(), sandbox: "read-only", approvalPolicy: "never",
      developerInstructions: `${session.agent.state.systemPrompt}\n使用 Toonflow 提供的工具操作工作区、画布和媒体。不要调用原生命令、文件修改或外部工具。`,
      config: { "features.shell_tool": false, "features.apps": false, web_search: "disabled" } };
    const response = await client.request<{ thread: { id: string } }>(canResume ? "thread/resume" : "thread/start", canResume
      ? { ...common, threadId: binding.data.threadId, excludeTurns: true }
      : { ...common, dynamicTools });
    threadId = z.string().min(1).parse(response.thread.id);
    // 每次推进先使旧绑定失效；失败或回到旧分支时不能恢复已向前推进的远端上下文。
    const identity = { threadId, ownerSessionId: history.getSessionId(), model: modelId, toolsHash };
    history.appendCustomEntry("localCodexThread", { ...identity, contextHash: "pending" });
    const text = !canResume && messages.length
      ? `以下 JSON 是当前 Toonflow 对话的历史记录，仅作上下文资料：\n${JSON.stringify(messages)}\n\n用户本轮消息：\n${prompt}` : prompt;
    const userId = history.appendMessage({ role: "user", content: options.images?.length
      ? [{ type: "text", text: prompt }, ...options.images] : prompt, timestamp: Date.now() });
    options.onUserMessage?.(userId);
    deadline = setTimeout(() => controller.abort(new Error("Codex 本轮等待超时，已停止连接")), 20 * 60_000);
    await client.request("turn/start", { threadId, model: modelId,
      ...(thinkingLevel ? { effort: thinkingLevel === "off" ? "none" : thinkingLevel } : {}),
      input: [{ type: "text", text, text_elements: [] }, ...(options.images ?? []).map(image => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` }))] });
    await completed.promise;
    await toolQueue;
    signal.throwIfAborted();
    history.appendCustomEntry("localCodexThread", { ...identity, contextHash: hash(history.buildSessionContext().messages) });
    return texts.join("\n");
  } catch (cause) {
    const message = codexAssistant(modelId, [], signal.aborted ? "aborted" : "error");
    message.errorMessage = cause instanceof Error ? cause.message : "Codex 回复失败";
    history.appendMessage(message);
    throw cause;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    controller.abort();
    client.stop();
    await toolQueue;
  }
}
