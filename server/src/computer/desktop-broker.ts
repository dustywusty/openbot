import { randomBytes, randomUUID } from "node:crypto";
import {
  type DesktopComputer,
  type DesktopComputerAction,
  type DesktopComputerEvent,
  type DesktopComputerEventBatch,
  type DesktopComputerOperation,
  type DesktopComputerPoll,
  desktopComputerAction,
  desktopComputerEventBatch,
  desktopComputerRegistration,
  desktopComputerUnregistration,
} from "@openbot/shared/desktop-computer";

export class DesktopComputerRefusedError extends Error {}
type Completion = Extract<DesktopComputerEvent, { type: "completed" }>;
type Registration = DesktopComputer & {
  ownerUserId: string;
  bindingId?: string;
  revision: string;
};
type Job = {
  operation: DesktopComputerOperation;
  sequence: number;
  bytes: number;
  leasedUntil: number;
  finishedAt: number | null;
  cancelPending: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Completion) => void;
  reject: (error: Error) => void;
  onEvent?: (event: DesktopComputerEvent) => void;
  detach?: () => void;
};

/**
 * A bounded, process-local queue for the existing desktop connection. No listener is created.
 * Live registrations and jobs do not survive a server restart. Durable pairing credentials authorize
 * fresh registrations through the separate store; they never restore old operations.
 */
export function createDesktopComputerBroker(options: {
  /** Called before queueing; bind this to the same bot/access policy as the runtime or gateway. */
  canDispatch: (input: {
    actorId: string;
    botId: string;
    computerId: string;
  }) => Promise<boolean>;
  now?: () => number;
  leaseMs?: number;
  runTimeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 15_000;
  const defaultTimeout = options.runTimeoutMs ?? 30 * 60_000;
  const connectionId = randomUUID();
  const tickets = new Map<string, { ownerUserId: string; expiresAt: number }>();
  const computers = new Map<string, Registration>();
  const jobs = new Map<string, Job>();
  const retentionMs = 60_000;
  let stopped = false;

  function refuse(message: string): never {
    throw new DesktopComputerRefusedError(message);
  }
  function sweep() {
    const current = now();
    for (const [ticket, entry] of tickets)
      if (entry.expiresAt <= current) tickets.delete(ticket);
    for (const [id, job] of jobs) {
      // Preserve an unacknowledged cancel until the original run deadline. A delayed worker must
      // not reconnect to find its stop forgotten while its original operation could still run.
      if (
        job.finishedAt !== null &&
        (job.cancelPending ? job.operation.expiresAt : job.finishedAt) +
          retentionMs <=
          current
      )
        jobs.delete(id);
      else if (job.finishedAt === null && job.operation.expiresAt <= current)
        finish(
          job,
          new DesktopComputerRefusedError("The computer operation expired."),
          true,
        );
    }
  }
  function owned(actorId: string, computerId: string) {
    const entry = computers.get(computerId);
    if (!entry || entry.ownerUserId !== actorId)
      refuse("That computer is not available to you.");
    return entry;
  }
  function finish(job: Job, result: Completion | Error, cancel = false) {
    if (job.finishedAt !== null) return;
    job.finishedAt = now();
    job.cancelPending = cancel;
    clearTimeout(job.timer);
    job.detach?.();
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
  }
  function publicComputer(entry: Registration): DesktopComputer {
    return { computerId: entry.computerId, name: entry.name };
  }
  function restoreRegistration(
    ownerUserId: string,
    input: DesktopComputer,
    bindingId?: string,
    resetOperations = false,
  ) {
    if (stopped) refuse("The desktop computer connection stopped.");
    const parsed = desktopComputerRegistration.parse(input);
    const previous = computers.get(parsed.computerId);
    if (previous && previous.ownerUserId !== ownerUserId)
      refuse("That computer is not available to you.");
    if (!previous && computers.size >= 128)
      refuse("Too many desktop computers are registered.");
    if (resetOperations || (previous && previous.bindingId !== bindingId)) {
      for (const job of jobs.values()) {
        if (job.operation.computerId === parsed.computerId)
          finish(
            job,
            new DesktopComputerRefusedError(
              "The workspace connection changed. Start a new turn.",
            ),
            true,
          );
      }
    }
    computers.set(parsed.computerId, {
      ...parsed,
      ownerUserId,
      revision: randomUUID(),
      ...(bindingId ? { bindingId } : {}),
    });
    return parsed;
  }
  function redeemPairingTicket(ticket: string) {
    sweep();
    const pairing = tickets.get(ticket);
    if (stopped || !pairing)
      refuse("That computer pairing request expired or was already used.");
    tickets.delete(ticket);
    return pairing.ownerUserId;
  }

  return {
    connectionId,
    /** Native registration response only; never resolve ownership from browser input. */
    ownerOf(computerId: string): string | null {
      return computers.get(computerId)?.ownerUserId ?? null;
    },
    bindingOf(computerId: string): string | null {
      return computers.get(computerId)?.bindingId ?? null;
    },
    registrationRevisionOf(computerId: string): string | null {
      return computers.get(computerId)?.revision ?? null;
    },
    restoreRegistration,
    redeemPairingTicket,
    createPairingTicket(ownerUserId: string) {
      sweep();
      if (
        stopped ||
        tickets.size >= 128 ||
        [...tickets.values()].filter(
          (ticket) => ticket.ownerUserId === ownerUserId,
        ).length >= 16
      )
        refuse("Computer pairing is not available right now.");
      const ticket = randomBytes(32).toString("hex");
      const expiresAt = now() + 5 * 60_000;
      tickets.set(ticket, { ownerUserId, expiresAt });
      return { ticket, expiresAt };
    },
    /** Only the authenticated desktop route may redeem a ticket. Owner comes from the ticket. */
    register(ticket: string, input: DesktopComputer): DesktopComputer {
      const owner = redeemPairingTicket(ticket);
      const previous = computers.get(input.computerId);
      if (previous && previous.ownerUserId !== owner)
        refuse("That computer belongs to another person.");
      return restoreRegistration(owner, input);
    },
    list(actorId: string): DesktopComputer[] {
      return [...computers.values()]
        .filter((entry) => entry.ownerUserId === actorId)
        .map(publicComputer);
    },
    /** Native deletion revokes the exact pairing, never a newer server session or another owner. */
    unregister(input: unknown) {
      const parsed = desktopComputerUnregistration.parse(input);
      if (parsed.connectionId !== connectionId)
        refuse("The desktop computer connection changed. Pair it again.");
      const previous = computers.get(parsed.computerId);
      // Idempotent for a retried deletion, but a different owner's pairing cannot be removed.
      if (!previous) return;
      owned(parsed.ownerUserId, parsed.computerId);
      computers.delete(parsed.computerId);
      for (const job of jobs.values()) {
        if (job.operation.computerId === parsed.computerId)
          finish(
            job,
            new DesktopComputerRefusedError("This workspace was disconnected."),
            true,
          );
      }
    },
    async dispatch(input: {
      actorId: string;
      botId: string;
      computerId: string;
      threadId: string;
      runId: string;
      action: DesktopComputerAction;
      timeoutMs?: number;
      signal?: AbortSignal;
      onEvent?: (event: DesktopComputerEvent) => void;
    }) {
      sweep();
      owned(input.actorId, input.computerId);
      if (!(await options.canDispatch(input)))
        refuse("That Bot cannot use this computer.");
      // Ownership and cancellation may have changed while the caller's access check ran.
      owned(input.actorId, input.computerId);
      if (stopped || input.signal?.aborted)
        refuse("The computer operation was stopped.");
      if (
        jobs.size >= 128 ||
        [...jobs.values()].filter((job) => job.finishedAt === null).length >= 64
      )
        refuse("Too many computer operations are running.");
      for (const value of [
        input.actorId,
        input.botId,
        input.threadId,
        input.runId,
      ]) {
        if (!value || value.length > 256)
          refuse(
            "The computer operation needs a valid owner, Bot, conversation and run.",
          );
      }
      const timeoutMs = input.timeoutMs ?? defaultTimeout;
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 2 * 60 * 60_000
      )
        refuse("Choose a computer operation deadline within two hours.");
      const operation: DesktopComputerOperation = {
        operationId: randomUUID(),
        computerId: input.computerId,
        actorId: input.actorId,
        botId: input.botId,
        threadId: input.threadId,
        runId: input.runId,
        expiresAt: now() + timeoutMs,
        action: desktopComputerAction.parse(input.action),
      };
      let resolve!: Job["resolve"];
      let reject!: Job["reject"];
      const completion = new Promise<Completion>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // A caller can attach its await after the worker has already refused the operation.
      void completion.catch(() => {});
      const timer = setTimeout(
        () =>
          finish(
            job,
            new DesktopComputerRefusedError("The computer operation expired."),
            true,
          ),
        timeoutMs,
      );
      timer.unref?.();
      const job: Job = {
        operation,
        sequence: 0,
        bytes: 0,
        leasedUntil: 0,
        finishedAt: null,
        cancelPending: false,
        timer,
        resolve,
        reject,
        onEvent: input.onEvent,
      };
      if (input.signal) {
        const cancel = () =>
          finish(
            job,
            new DesktopComputerRefusedError(
              "The computer operation was stopped.",
            ),
            true,
          );
        input.signal.addEventListener("abort", cancel, { once: true });
        job.detach = () => input.signal?.removeEventListener("abort", cancel);
      }
      jobs.set(operation.operationId, job);
      return { operationId: operation.operationId, completion };
    },
    poll(): DesktopComputerPoll {
      sweep();
      const next = [...jobs.values()].find(
        (job) => job.finishedAt === null && job.leasedUntil <= now(),
      );
      if (next) next.leasedUntil = now() + leaseMs;
      return {
        connectionId,
        operations: next ? [structuredClone(next.operation)] : [],
        cancellations: [...jobs.values()]
          .filter((job) => job.cancelPending)
          .map((job) => job.operation.operationId),
        leaseMs,
      };
    },
    /** Ack only contiguous events. Retries of accepted sequence numbers have no side effects. */
    acceptEvents(input: DesktopComputerEventBatch) {
      sweep();
      const batch = desktopComputerEventBatch.parse(input);
      const job = jobs.get(batch.operationId);
      if (!job) refuse("That computer operation is no longer available.");
      for (const { sequence, event } of batch.events) {
        if (sequence <= job.sequence) continue;
        if (job.finishedAt !== null) {
          if (event.type === "completed" || event.type === "failed")
            job.cancelPending = false;
          break;
        }
        if (sequence !== job.sequence + 1)
          return { acceptedSequence: job.sequence, finished: false };
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (job.sequence >= 4096 || job.bytes + bytes > 8 * 1024 * 1024) {
          finish(
            job,
            new DesktopComputerRefusedError(
              "The computer operation produced too much output.",
            ),
            true,
          );
          break;
        }
        job.sequence = sequence;
        job.bytes += bytes;
        job.leasedUntil = now() + leaseMs;
        try {
          job.onEvent?.(event);
        } catch {
          finish(
            job,
            new DesktopComputerRefusedError(
              "The computer output could not be delivered.",
            ),
            true,
          );
          break;
        }
        if (event.type === "completed") finish(job, event);
        else if (event.type === "failed")
          finish(job, new DesktopComputerRefusedError(event.message));
      }
      return {
        acceptedSequence: job.sequence,
        finished: job.finishedAt !== null,
      };
    },
    cancel(actorId: string, operationId: string) {
      sweep();
      const job = jobs.get(operationId);
      if (!job || job.operation.actorId !== actorId)
        refuse("That computer operation is not available to you.");
      finish(
        job,
        new DesktopComputerRefusedError("The computer operation was stopped."),
        true,
      );
    },
    revokeOwner(ownerUserId: string) {
      for (const entry of [...computers.values()]) {
        if (entry.ownerUserId === ownerUserId)
          this.unregister({
            computerId: entry.computerId,
            ownerUserId,
            connectionId,
          });
      }
    },
    dispose() {
      stopped = true;
      for (const job of jobs.values())
        finish(
          job,
          new DesktopComputerRefusedError(
            "The desktop computer connection stopped.",
          ),
          true,
        );
      tickets.clear();
      computers.clear();
    },
  };
}

export type DesktopComputerBroker = ReturnType<
  typeof createDesktopComputerBroker
>;
