import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export function nativeExecutable(name: "codex" | "claude"): string {
  const local = join(homedir(), ".local", "bin", name);
  return existsSync(local) ? local : name;
}

/** Local coding profiles use the CLI account, never the deployment's API key. */
export function accountEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    delete environment[key];
  return environment;
}

type Notification = {
  method: string;
  params: {
    threadId?: string;
    itemId?: string;
    delta?: string;
    item?: { id?: string };
    turn?: { id?: string; status?: string };
  };
};
export class CodexClient {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(event: Notification) => void>();
  readonly ready: Promise<void>;
  closed = false;
  constructor(
    cwd: string,
    start: () => ChildProcessWithoutNullStreams = () =>
      spawn(nativeExecutable("codex"), ["app-server"], {
        cwd,
        env: accountEnvironment(),
        stdio: "pipe",
      }),
  ) {
    this.child = start();
    // Drain stderr without exposing account details in logs or API errors.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.stop());
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let message: {
        id?: string | number;
        method?: string;
        params?: Notification["params"];
        result?: unknown;
        error?: unknown;
      };
      try {
        message = JSON.parse(line);
      } catch {
        this.stop();
        return;
      }
      if (message.method && message.id !== undefined) {
        // Approvals are never granted implicitly. Workspace writes are governed by
        // the profile's sandbox; requests to leave it fail closed.
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message: "Interactive approvals are not available in this profile.",
          },
        });
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new Error(
              "Codex rejected the request. Check the selected model and CLI sign-in.",
            ),
          );
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners)
          listener({ method: message.method, params: message.params ?? {} });
      }
    });
    const fail = () => {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            "Codex stopped. Install Codex and sign in with codex login.",
          ),
        );
      }
      this.pending.clear();
      for (const listener of this.listeners)
        listener({ method: "openbot/closed", params: {} });
    };
    this.child.on("error", fail);
    this.child.on("exit", fail);
    this.ready = this.request("initialize", {
      clientInfo: { name: "openbot", version: "0.1.0" },
    }).then(() => {
      this.send({ method: "initialized", params: {} });
    });
  }
  private send(message: unknown) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex is stopped."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex did not answer in time."));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.send({ id, method, ...(params ? { params } : {}) });
    });
  }
  listen(listener: (event: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  stop() {
    this.child.kill("SIGTERM");
  }
}
