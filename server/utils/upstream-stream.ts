import type { ChatMessage, UpstreamChoice, UpstreamCompletion, UpstreamUsage } from "~/server/utils/types.ts";

export interface CollectedUpstreamStream {
  completion: UpstreamCompletion;
  frames: UpstreamCompletion[];
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
  } catch {
    return undefined;
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
    throw new Error(message);
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

export async function collectUpstreamStream(response: Response): Promise<CollectedUpstreamStream> {
  if (!response.body) {
    throw new Error("Upstream returned an empty streaming body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const frames: UpstreamCompletion[] = [];
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const frame = parseDataLine(line.replace(/\r$/, ""));
      if (frame) {
        frames.push(frame);
      }
    }
  }
  buffer += decoder.decode();
  const finalFrame = parseDataLine(buffer.replace(/\r$/, ""));
  if (finalFrame) {
    frames.push(finalFrame);
  }

  return { completion: assemble(frames), frames };
}

export function openAISse(events: Array<{ event?: string; data: unknown }>, options?: { doneMarker?: boolean }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const entry of events) {
        const prefix = entry.event ? `event: ${entry.event}\n` : "";
        controller.enqueue(encoder.encode(`${prefix}data: ${JSON.stringify(entry.data)}\n\n`));
      }
      if (options?.doneMarker !== false) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
      controller.close();
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

export function choiceFromCompletion(completion: UpstreamCompletion): UpstreamChoice {
  return completion.choices?.[0] ?? { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" };
}
