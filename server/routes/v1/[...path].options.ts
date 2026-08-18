import { defineHandler } from "nitro";

export default defineHandler(() => new Response(null, {
  status: 204,
  headers: { "Cache-Control": "no-store" },
}));
