import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { type BaseEvent, EventType } from "@ag-ui/core";
import type { WorkspaceBot } from "@openbot/shared/workspace-bot";
import { Observable } from "rxjs";
import type { DesktopComputerBroker } from "./desktop-broker";

export type HarnessChoice = Pick<WorkspaceBot, "model" | "effort" | "speed">;
type Options = {
  actorId: string;
  botId: string;
  name: string;
  settings: WorkspaceBot;
  instructions: string;
  broker: DesktopComputerBroker;
  choice?: (threadId: string) => Promise<HarnessChoice>;
};

/** CLI output enters the same AG-UI run and transcript as every other Bot. No browser execution. */
export class DesktopHarnessAgent extends AbstractAgent {
  private options: Options;
  private active?: AbortController;
  constructor(options: Options) {
    super({ agentId: options.botId, description: options.name });
    this.options = options;
  }
  clone(): DesktopHarnessAgent {
    const clone = super.clone() as DesktopHarnessAgent;
    clone.options = this.options;
    clone.active = undefined;
    return clone;
  }
  abortRun() {
    this.active?.abort();
    super.abortRun();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const controller = new AbortController();
      this.active = controller;
      const { options } = this;
      const messageId = `desktop-${input.runId}`;
      let started = false;
      let text = "";
      const send = (event: BaseEvent) => {
        if (!observer.closed) observer.next(event);
      };
      const append = (delta: string) => {
        if (!delta) return;
        if (!started) {
          started = true;
          send({
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
            name: options.name,
          } as BaseEvent);
        }
        text += delta;
        send({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
        } as BaseEvent);
      };
      send({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      void (async () => {
        const message = [...input.messages]
          .reverse()
          .find((candidate) => candidate.role === "user");
        const content = message?.content;
        let prompt: string;
        if (typeof content === "string") prompt = content;
        else if (
          Array.isArray(content) &&
          content.every((part) => part.type === "text")
        )
          prompt = content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n");
        else
          throw new Error(
            "Send a text task to this coding Bot. File attachments are not supported yet.",
          );
        if (!prompt.trim())
          throw new Error("Send this coding Bot a task to work on.");
        const choice = options.choice
          ? await options.choice(input.threadId)
          : options.settings;
        controller.signal.throwIfAborted();
        const { completion } = await options.broker.dispatch({
          actorId: options.actorId,
          botId: options.botId,
          computerId: options.settings.workspaceId,
          threadId: input.threadId,
          runId: input.runId,
          signal: controller.signal,
          action: {
            kind: "harness_turn",
            runtime: options.settings.runtime,
            prompt,
            developerInstructions: options.instructions,
            ...(choice.model ? { model: choice.model } : {}),
            ...(choice.effort
              ? { effort: choice.effort as WorkspaceBot["effort"] & string }
              : {}),
            ...(choice.speed ? { speed: choice.speed } : {}),
            permission: options.settings.permission,
          },
          onEvent: (event) => {
            if (event.type === "output" && event.stream === "assistant")
              append(event.text);
          },
        });
        const result = await completion;
        controller.signal.throwIfAborted();
        if (result.exitCode !== undefined && result.exitCode !== 0)
          throw new Error("The coding turn stopped before it completed.");
        if (
          !text &&
          result.result &&
          typeof result.result === "object" &&
          "text" in result.result &&
          typeof result.result.text === "string"
        )
          append(result.result.text);
        if (!text) append("The coding turn completed without a text response.");
        if (started)
          send({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
        send({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        observer.complete();
      })().catch((error: unknown) => {
        if (controller.signal.aborted) {
          observer.complete();
          return;
        }
        if (started)
          send({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
        send({
          type: EventType.RUN_ERROR,
          message:
            error instanceof Error
              ? error.message
              : "The VM could not complete the coding turn.",
          code: "DESKTOP_COMPUTER_FAILED",
        } as BaseEvent);
        observer.complete();
      });
      return () => {
        controller.abort();
        if (this.active === controller) this.active = undefined;
      };
    });
  }
}
