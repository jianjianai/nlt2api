import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDuration,
  formatLatency,
  formatRelative,
  formatRemaining,
  formatTime,
  poolTone,
  PROXY_STATUS_LABEL,
  PROXY_STATUS_TONE,
  SETTING_LABEL,
} from "~/app/utils/admin-ui.ts";
import { DEFAULT_SETTINGS } from "~/server/utils/settings.ts";

test("every setting has a label and hint in the console", () => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const entry = SETTING_LABEL[key as keyof typeof SETTING_LABEL];
    assert.ok(entry, `missing label for ${key}`);
    assert.ok(entry.label.length > 0 && entry.hint.length > 0);
  }
});

test("every proxy status has a label and a tone", () => {
  for (const status of ["active", "pending", "unavailable"] as const) {
    assert.ok(PROXY_STATUS_LABEL[status]);
    assert.ok(PROXY_STATUS_TONE[status]);
  }
});

test("poolTone reflects the water level against the floor", () => {
  assert.equal(poolTone(4, 4), "good");
  assert.equal(poolTone(9, 4), "good");
  assert.equal(poolTone(1, 4), "warn");
  assert.equal(poolTone(0, 4), "bad");
});

test("duration formatting picks a sensible unit", () => {
  assert.equal(formatDuration(30), "30 秒");
  assert.equal(formatDuration(90), "1 分");
  assert.equal(formatDuration(7_200), "2 小时");
  assert.equal(formatDuration(172_800), "2 天");
});

test("remaining time falls back to an expired label", () => {
  assert.equal(formatRemaining(0), "已过期");
  assert.equal(formatRemaining(-1), "已过期");
  assert.equal(formatRemaining(45_000), "45 秒");
  assert.equal(formatRemaining(125_000), "2 分 5 秒");
});

test("missing timestamps and latencies render as a dash", () => {
  assert.equal(formatTime(undefined), "—");
  assert.equal(formatRelative(undefined, Date.now()), "—");
  assert.equal(formatLatency(undefined), "—");
  assert.equal(formatLatency(42), "42 ms");
});

test("relative time handles past, present and future", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelative(now, now), "刚刚");
  assert.equal(formatRelative(now - 90_000, now), "1 分前");
  assert.equal(formatRelative(now + 90_000, now), "1 分后");
});
