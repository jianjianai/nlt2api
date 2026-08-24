import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireClientAuth } from "~/server/utils/http.ts";

// DeepSeek 兼容余额端点：供 sub2api-jian 等渠道监控探测（GET {base_url}/user/balance）。
// 本网关按量转发、无真实余额概念，固定返回 999 表示额度充足，避免触发余额不足告警。
export default defineHandler(async (event) => {
  try {
    await requireClientAuth(event.req);
    return jsonResponse({
      is_available: true,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "999.00",
          granted_balance: "0.00",
          topped_up_balance: "999.00",
        },
      ],
    });
  } catch (error) {
    return openAIErrorResponse(error);
  }
});
