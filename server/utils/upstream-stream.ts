import type { ChatMessage, UpstreamChoice, UpstreamCompletion, UpstreamUsage } from "~/server/utils/types.ts";

/** A structured error reported inside an HTTP-200 upstream SSE stream. */
export class UpstreamStreamError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  readonly rawResponse: string | undefined;

  constructor(
    message: string,
    status = 502,
    retryAfterSeconds?: number,
    rawResponse?: string,
  ) {
    super(message);
    this.name = "UpstreamStreamError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.rawResponse = rawResponse;
  }
}

export interface CollectedUpstreamStream {
  completion: UpstreamCompletion;
  frames: UpstreamCompletion[];
  raw: string;
}

/**
 * Return true only when the frame produced a client-visible event. This lets
 * the scheduler retry an upstream stream which failed before it emitted any
 * meaningful delta (for example, a portal-only empty role frame).
 */
export type UpstreamFrameHandler = (frame: UpstreamCompletion) => boolean | void | Promise<boolean | void>;

export interface SseEntry {
  event?: string;
  data: unknown;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function mergeDelta(target: ChatMessage, delta: ChatMessage): void {
  if (typeof delta.content === "string") {
    target.content = `${typeof target.content === "string" ? target.content : ""}${delta.content}`;
  }
  if (typeof delta.reasoning === "string") {
    target.reasoning = `${target.reasoning ?? ""}${delta.reasoning}`;
  }
  if (typeof delta.reasoning_content === "string") {
    target.reasoning_content = `${target.reasoning_content ?? ""}${delta.reasoning_content}`;
  }
  if (typeof delta.refusal === "string") {
    target.refusal = `${typeof target.refusal === "string" ? target.refusal : ""}${delta.refusal}`;
  }
  if (delta.role) {
    target.role = delta.role;
  }
  if (Array.isArray(delta.tool_calls)) {
    const existing = target.tool_calls ?? [];
    for (const partialValue of delta.tool_calls as unknown[]) {
      const partial = asObject(partialValue) ?? {};
      const index = typeof partial.index === "number"
        ? partial.index
        : existing.length;
      const known = existing[index];
      const partialFunction = asObject(partial.function) ?? {};
      if (!known) {
        existing[index] = {
          id: typeof partial.id === "string" ? partial.id : "",
          type: "function",
          function: {
            name: typeof partialFunction.name === "string" ? partialFunction.name : "",
            arguments: typeof partialFunction.arguments === "string" ? partialFunction.arguments : "",
          },
        };
      } else {
        if (typeof partial.id === "string") {
          known.id = partial.id;
        }
        if (typeof partialFunction.name === "string") {
          known.function.name = partialFunction.name;
        }
        if (typeof partialFunction.arguments === "string") {
          known.function.arguments += partialFunction.arguments;
        }
      }
    }
    target.tool_calls = existing;
  }
}

function parseDataLine(line: string): UpstreamCompletion | undefined {
  if (!line.startsWith("data:")) {
    return undefined;
  }
  const data = line.slice(5).trimStart();
  if (!data || data === "[DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(data) as UpstreamCompletion;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON parse error";
    throw new Error(`Upstream SSE contained invalid JSON data: ${detail}`);
  }
}

function assemble(frames: UpstreamCompletion[]): UpstreamCompletion {
  if (frames.length === 0) {
    throw new Error("Upstream streaming response contained no data frames.");
  }
  const errorFrame = frames.find((frame) => frame.error !== undefined);
  if (errorFrame) {
    const error = asObject(errorFrame.error);
    const message = typeof errorFrame.error === "string"
      ? errorFrame.error
      : typeof error?.message === "string"
        ? error.message
        : "Upstream streaming response contained an error frame.";
    const statusValue = typeof errorFrame.status === "number"
      ? errorFrame.status
      : typeof error?.status === "number"
        ? error.status
        : 502;
    const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599
      ? statusValue
      : 502;
    const retryValue = errorFrame.retry_after ?? error?.retry_after;
    const retryAfterSeconds = typeof retryValue === "number" && Number.isFinite(retryValue) && retryValue > 0
      ? Math.min(retryValue, 86_400)
      : undefined;
    throw new UpstreamStreamError(message, status, retryAfterSeconds);
  }
  const first = frames.find((frame) => frame.choices?.length) ?? {};
  const message: ChatMessage = { role: "assistant", content: "" };
  let finishReason: string | null | undefined;
  let usage: UpstreamUsage | undefined;
  for (const frame of frames) {
    if (frame.usage) {
      usage = frame.usage;
    }
    const choice = frame.choices?.[0];
    if (!choice) {
      continue;
    }
    if (choice.delta) {
      mergeDelta(message, choice.delta);
    }
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  return {
    id: first.id,
    object: "chat.completion",
    created: first.created,
    model: first.model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage,
  };
}

export async function collectUpstreamStream(
  response: Response,
  onFrame?: UpstreamFrameHandler,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<CollectedUpstreamStream> {
  if (!response.body) {
    throw new Error("Upstream returned an empty streaming body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let totalBytes = 0;
  const frames: UpstreamCompletion[] = [];
  try {
    for await (const chunk of response.body) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error("The NeuralWatt portal response exceeded the adapter limit.");
      }
      const decoded = decoder.decode(chunk, { stream: true });
      raw += decoded;
      buffer += decoded;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const frame = parseDataLine(line.replace(/\r$/, ""));
        if (frame) {
          frames.push(frame);
          // Error frames are handled by assemble() so callers never render an
          // upstream error as model output. Ordinary frames can be forwarded as
          // soon as they arrive while we continue collecting the final shape.
          if (!frame.error && onFrame) {
            await onFrame(frame);
          }
        }
      }
    }
    const finalDecoded = decoder.decode();
    raw += finalDecoded;
    buffer += finalDecoded;
    const finalFrame = parseDataLine(buffer.replace(/\r$/, ""));
    if (finalFrame) {
      frames.push(finalFrame);
      if (!finalFrame.error && onFrame) {
        await onFrame(finalFrame);
      }
    }
    return { completion: assemble(frames), frames, raw };
  } catch (error) {
    if (error instanceof UpstreamStreamError) {
      if (!error.rawResponse) {
        throw new UpstreamStreamError(error.message, error.status, error.retryAfterSeconds, raw);
      }
      throw error;
    }
    throw new UpstreamStreamError(
      error instanceof Error ? error.message : "The NeuralWatt portal streaming response failed.",
      502,
      undefined,
      raw,
    );
  }
}

function encodeSse(encoder: TextEncoder, entry: SseEntry): Uint8Array {
  const prefix = entry.event ? `event: ${entry.event}\n` : "";
  return encoder.encode(`${prefix}data: ${JSON.stringify(entry.data)}\n\n`);
}

export function openAIStreamingSse(
  producer: (emit: (entry: SseEntry) => Promise<void>, signal: AbortSignal) => Promise<void>,
  options?: {
    doneMarker?: boolean;
    onError?: (error: unknown) => SseEntry | undefined;
  },
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const abortController = new AbortController();
  let wakeCapacity: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const waitForCapacity = async (): Promise<void> => {
        while (!closed && (controller.desiredSize ?? 1) <= 0) {
          await new Promise<void>((resolve) => {
            wakeCapacity = resolve;
          });
        }
      };

      const write = async (data: Uint8Array): Promise<void> => {
        await waitForCapacity();
        if (closed) return;
        try {
          controller.enqueue(data);
        } catch {
          closed = true;
        }
      };

      const emit = async (entry: SseEntry): Promise<void> => write(encodeSse(encoder, entry));
      const close = async (): Promise<void> => {
        if (closed) return;
        if (options?.doneMarker !== false) {
          await write(encoder.encode("data: [DONE]\n\n"));
        }
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // A cancelled stream is already closed.
        }
      };
      void producer(emit, abortController.signal).then(close).catch(async (error) => {
        if (closed) return;
        const entry = options?.onError?.(error);
        if (entry) await emit(entry);
        await close();
      });
    },
    pull() {
      const wake = wakeCapacity;
      wakeCapacity = undefined;
      wake?.();
    },
    cancel() {
      closed = true;
      abortController.abort();
      const wake = wakeCapacity;
      wakeCapacity = undefined;
      wake?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export function openAISse(events: SseEntry[], options?: { doneMarker?: boolean }): Response {
  return openAIStreamingSse(async (emit) => {
    for (const entry of events) {
      await emit(entry);
    }
  }, options);
}

export function choiceFromCompletion(completion: UpstreamCompletion): UpstreamChoice {
  return completion.choices?.[0] ?? { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" };
}
