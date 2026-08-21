// sub2api-jian 的 DeepSeek 余额探测 URL 由账号 base_url 直接拼接 /user/balance，
// base_url 可能带 /v1 也可能不带，这里复用同一处理器同时暴露两种路径。
export { default } from "~/server/routes/v1/user/balance.get.ts";
