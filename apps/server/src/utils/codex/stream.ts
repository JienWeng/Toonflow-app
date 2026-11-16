import { createAssistantMessageEventStream, type Context, type ThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import { CodexClient } from "./client";
import { localCodexSettings } from "./models";
import { codexAssistant } from "./session";
import { requireDirectModelAccess } from "@/utils/multiTenant/gateway";

// 无会话的文本节点保持原有完整上下文请求语义；Agent 使用 session.ts 的持久线程。
export function streamCodexText(modelId: string, context: Context, signal: AbortSignal,
  references: { dataType: string; value: string }[], thinkingLevel?: ThinkingLevel) {
  const stream = createAssistantMessageEventStream();
  let submitted = false;
  void (async () => {
    const message = codexAssistant(modelId, [{ type: "text", text: "" }]);
    const completion = Promise.withResolvers<void>();
    void completion.promise.catch(() => {});
    let client: CodexClient | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const abort = () => { completion.reject(signal.reason ?? new Error("Codex 回复已停止")); client?.stop(); };
    try {
      requireDirectModelAccess();
      signal.throwIfAborted();
      const settings = localCodexSettings();
      if (!settings.enabled) throw new Error("本地 Codex 已关闭");
      if (references.some(reference => reference.dataType === "VIDEO")) throw new Error("本地 Codex 不支持视频附件，请先提取关键帧或使用文本说明");
      const images: string[] = [];
      const transcript = JSON.stringify(context.messages, (_name, value: unknown) => {
        if (value && typeof value === "object" && "type" in value && value.type === "image" && "data" in value && "mimeType" in value) {
          images.push(`data:${value.mimeType};base64,${value.data}`);
          return { type: "text", text: "[图片作为本轮图片输入提供]" };
        }
        return value;
      });
      for (const reference of references) if (reference.dataType === "IMAGE") images.push(reference.value);
      client = new CodexClient(settings.executable);
      signal.addEventListener("abort", abort, { once: true });
      void client.closed.then(error => completion.reject(error));
      let threadId = "";
      client.onNotification = (method, params) => {
        if (params.threadId !== threadId || finished) return;
        if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
          const part = message.content[0];
          if (part?.type !== "text") return;
          part.text += params.delta;
          stream.push({ type: "text_delta", contentIndex: 0, delta: params.delta, partial: message });
        }
        if (method === "turn/completed") {
          const turn = params.turn as { status?: string } | undefined;
          if (turn?.status === "completed") completion.resolve();
          else completion.reject(new Error("本地 Codex 回复失败或已停止"));
        }
      };
      client.onRequest = async (method, params) => {
        if (method !== "item/tool/call" || params.threadId !== threadId || finished) throw new Error("未授权的 Codex 操作");
        const call = z.object({ callId: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).parse(params);
        if (!context.tools?.some(tool => tool.name === call.tool)) throw new Error("工具未授权");
        message.content.push({ type: "toolCall", id: call.callId, name: call.tool, arguments: call.arguments });
        message.stopReason = "toolUse";
        stream.push({ type: "toolcall_end", contentIndex: message.content.length - 1,
          toolCall: { type: "toolCall", id: call.callId, name: call.tool, arguments: call.arguments }, partial: message });
        finished = true;
        completion.resolve();
        // 工具调用交回原请求方执行；不在 Codex 中执行第二份。
        return { success: false, contentItems: [{ type: "inputText", text: "工具调用已交给 Toonflow 请求方处理" }] };
      };
      await client.initialize();
      const account = await client.request<{ account: unknown }>("account/read", { refreshToken: false });
      if (!account.account) throw new Error("请先在 Toonflow 服务所在机器运行 codex login");
      const response = await client.request<{ thread: { id: string } }>("thread/start", {
        model: modelId, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
        config: { "features.shell_tool": false, "features.apps": false, web_search: "disabled" },
        developerInstructions: `${context.systemPrompt ?? ""}\n根据输入的 JSON 对话上下文回答最后的用户消息。仅使用明确提供的工具。`,
        dynamicTools: (context.tools ?? []).map(tool => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters })),
      });
      threadId = z.string().min(1).parse(response.thread.id);
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      deadline = setTimeout(() => completion.reject(new Error("本地 Codex 回复超时")), 5 * 60_000);
      submitted = true;
      await client.request("turn/start", { threadId, model: modelId, ...(thinkingLevel ? { effort: thinkingLevel } : {}), input: [
        { type: "text", text: `${transcript}\n${references.filter(reference => reference.dataType === "STRING").map(reference => reference.value).join("\n")}`, text_elements: [] },
        ...images.map(url => ({ type: "image", url })),
      ] });
      await completion.promise;
      signal.throwIfAborted();
      const part = message.content[0];
      stream.push({ type: "text_end", contentIndex: 0, content: part?.type === "text" ? part.text : "", partial: message });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    } catch (cause) {
      message.stopReason = signal.aborted ? "aborted" : "error";
      message.errorMessage = cause instanceof Error ? cause.message : "本地 Codex 请求失败";
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      finished = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      client?.stop();
      stream.end(message);
    }
  })();
  return Object.assign(stream, { billingUsage: () => undefined, upstreamSubmitted: () => submitted, upstreamRejected: () => false });
}
