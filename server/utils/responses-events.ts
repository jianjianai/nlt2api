import type { JsonObject } from "~/server/utils/types.ts";

export interface ResponseStreamEvent {
  event: string;
  data: JsonObject;
}

export function responsesStreamEvents(response: JsonObject): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [];
  const output = Array.isArray(response.output) ? response.output as JsonObject[] : [];
  const created: JsonObject = {
    ...response,
    status: "in_progress",
    output: [],
    output_text: "",
    usage: null,
    incomplete_details: null,
    completed_at: null,
  };
  events.push({ event: "response.created", data: { type: "response.created", response: created } });
  events.push({
    event: "response.in_progress",
    data: {
      type: "response.in_progress",
      response: { ...created, usage: null, incomplete_details: null },
    },
  });

  output.forEach((item, outputIndex) => {
    const itemId = typeof item.id === "string" ? item.id : "";
    const addedItem: JsonObject = item.type === "function_call"
      ? { ...item, status: "in_progress", arguments: "" }
      : item.type === "reasoning"
        ? { ...item, status: "in_progress", summary: [] }
        : { ...item, status: "in_progress", content: [] };
    events.push({
      event: "response.output_item.added",
      data: { type: "response.output_item.added", output_index: outputIndex, item: addedItem },
    });

    if (item.type === "function_call") {
      const argumentsValue = String(item.arguments ?? "");
      const name = String(item.name ?? "");
      events.push({
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          output_index: outputIndex,
          item_id: itemId,
          delta: argumentsValue,
        },
      });
      events.push({
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          output_index: outputIndex,
          item_id: itemId,
          name,
          arguments: argumentsValue,
        },
      });
    } else if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary[0] as JsonObject : undefined;
      const text = typeof summary?.text === "string" ? summary.text : "";
      const part = { type: "summary_text", text };
      events.push({
        event: "response.reasoning_summary_part.added",
        data: {
          type: "response.reasoning_summary_part.added",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        },
      });
      if (text) {
        events.push({
          event: "response.reasoning_summary_text.delta",
          data: {
            type: "response.reasoning_summary_text.delta",
            output_index: outputIndex,
            item_id: itemId,
            summary_index: 0,
            delta: text,
          },
        });
      }
      events.push({
        event: "response.reasoning_summary_text.done",
        data: {
          type: "response.reasoning_summary_text.done",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: 0,
          text,
        },
      });
      events.push({
        event: "response.reasoning_summary_part.done",
        data: {
          type: "response.reasoning_summary_part.done",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: 0,
          part,
        },
      });
    } else {
      const content = Array.isArray(item.content) ? item.content[0] as JsonObject : undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      const part = { type: "output_text", text, annotations: [], logprobs: [] };
      events.push({
        event: "response.content_part.added",
        data: {
          type: "response.content_part.added",
          output_index: outputIndex,
          item_id: itemId,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [], logprobs: [] },
        },
      });
      if (text) {
        events.push({
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            output_index: outputIndex,
            item_id: itemId,
            content_index: 0,
            delta: text,
            logprobs: [],
          },
        });
      }
      events.push({
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: outputIndex,
          item_id: itemId,
          content_index: 0,
          text,
          logprobs: [],
        },
      });
      events.push({
        event: "response.content_part.done",
        data: {
          type: "response.content_part.done",
          output_index: outputIndex,
          item_id: itemId,
          content_index: 0,
          part,
        },
      });
    }
    events.push({
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: outputIndex, item },
    });
  });

  const terminalEvent = response.status === "incomplete" ? "response.incomplete" : "response.completed";
  events.push({ event: terminalEvent, data: { type: terminalEvent, response } });
  return events.map((entry, sequenceNumber) => ({
    ...entry,
    data: { ...entry.data, sequence_number: sequenceNumber },
  }));
}
