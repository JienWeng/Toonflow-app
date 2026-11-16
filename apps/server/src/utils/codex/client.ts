import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type RpcMessage = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };

// ACT: 每次连接由调用方持有并关闭，不共享登录凭据或工作区运行状态。
export class CodexClient {
  private process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private stopped = false;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private ended = Promise.withResolvers<Error>();
  readonly closed = this.ended.promise;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  onRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;

  constructor(executable: string, cwd?: string) {
    this.process = spawn(executable, ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024 * 1024) { this.stop(new Error("Codex 响应超过大小限制")); return; }
      let boundary: number;
      while ((boundary = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, boundary).trim();
        this.buffer = this.buffer.slice(boundary + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line) as RpcMessage); }
        catch { this.stop(new Error("Codex app-server 返回了无效协议消息，请升级 Codex CLI")); return; }
      }
    });
    // 不将诊断输出、账号信息或凭据转发给浏览器。
    this.process.stderr.resume();
    this.process.stdin.on("error", () => this.stop(new Error("Codex 连接已关闭")));
    this.process.on("error", () => this.stop(new Error("Could not start Codex. Install Codex CLI and run codex login on the machine running Toonflow.")));
    this.process.on("exit", () => this.stop(new Error("Codex app-server 已退出，请检查本地安装与登录状态")));
  }

  private write(message: unknown) {
    if (this.stopped) throw new Error("Codex 连接已关闭");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: RpcMessage) {
    if (message.method) {
      if (message.id !== undefined) {
        const requestId = message.id;
        void (async () => {
          try {
            if (!this.onRequest) throw new Error("不支持此 Codex 请求");
            const result = await this.onRequest(message.method!, message.params ?? {});
            if (!this.stopped) this.write({ id: requestId, result });
          } catch {
            if (!this.stopped) this.write({ id: requestId, error: { code: -32601, message: "Toonflow 未授权此操作" } });
          }
        })();
      } else this.onNotification?.(message.method, message.params ?? {});
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error("Codex 请求失败，请检查 CLI 版本、登录状态与模型权限。"));
    else pending.resolve(message.result);
  }

  request<T>(method: string, params: unknown, timeout = 30000): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Codex 连接已关闭"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 超时，请检查本地 Codex 是否可用`));
      }, timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.write({ id, method, params }); }
      catch (cause) { clearTimeout(timer); this.pending.delete(id); reject(cause); }
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "toonflow", title: "Toonflow", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized", params: {} });
  }

  stop(error = new Error("Codex 连接已关闭")) {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.ended.resolve(error);
    this.process.stdin.end();
    this.process.kill();
    const timer = setTimeout(() => { if (this.process.exitCode === null) this.process.kill("SIGKILL"); }, 1000);
    timer.unref();
  }
}
