import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, settingBounds } from "~/server/utils/settings.ts";
import { HttpError } from "~/server/utils/http.ts";
import { createHarness } from "~/tests/harness.ts";

test("defaults are returned when nothing was ever stored", () => {
  const harness = createHarness();
  try {
    assert.deepEqual(harness.settings.get(), DEFAULT_SETTINGS);
  } finally {
    harness.close();
  }
});

test("the default ticket TTL stays under the measured upstream ceiling", () => {
  // Upstream accepted a 178s-old ticket and rejected one at 245s.
  assert.ok(DEFAULT_SETTINGS.ticketTtlSeconds <= 178);
  assert.equal(settingBounds().ticketTtlSeconds.max, 178);
});

test("a patch persists and is visible to a fresh store", () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ minAvailableTickets: 12 });
    harness.settings.invalidate();
    assert.equal(harness.settings.get().minAvailableTickets, 12);
  } finally {
    harness.close();
  }
});

test("unknown keys and out-of-range values are rejected", () => {
  const harness = createHarness();
  try {
    assert.throws(() => harness.settings.patch({ nope: 1 }), HttpError);
    assert.throws(() => harness.settings.patch({ ticketTtlSeconds: 600 }), HttpError);
    assert.throws(() => harness.settings.patch({ ticketTtlSeconds: 1 }), HttpError);
    assert.throws(() => harness.settings.patch({ maxAttempts: 1.5 }), HttpError);
    assert.throws(() => harness.settings.patch({ maxAttempts: "3" }), HttpError);
    assert.deepEqual(harness.settings.get(), DEFAULT_SETTINGS);
  } finally {
    harness.close();
  }
});

test("the freshness floor must stay below the TTL", () => {
  const harness = createHarness();
  try {
    assert.throws(
      () => harness.settings.patch({ ticketTtlSeconds: 40, ticketMinRemainingSeconds: 60 }),
      HttpError,
    );
  } finally {
    harness.close();
  }
});

test("corrupt stored settings fall back to defaults instead of throwing", () => {
  const harness = createHarness();
  try {
    harness.db.prepare("INSERT INTO settings (key, value) VALUES ('gateway', 'not json')").run();
    harness.settings.invalidate();
    assert.deepEqual(harness.settings.get(), DEFAULT_SETTINGS);
  } finally {
    harness.close();
  }
});

test("stored out-of-range values are clamped on read", () => {
  const harness = createHarness();
  try {
    harness.db.prepare("INSERT INTO settings (key, value) VALUES ('gateway', ?)")
      .run(JSON.stringify({ ticketTtlSeconds: 9_000, minAvailableTickets: -5 }));
    harness.settings.invalidate();
    const settings = harness.settings.get();
    assert.equal(settings.ticketTtlSeconds, settingBounds().ticketTtlSeconds.max);
    assert.equal(settings.minAvailableTickets, settingBounds().minAvailableTickets.min);
  } finally {
    harness.close();
  }
});
