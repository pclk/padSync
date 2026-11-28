import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { STEADY_MS, watchWake } from "../bridge/wake";

// The bridge stays quiet through a Power Nap wake, so padSync's database can stay asleep overnight.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("is steady from the start, and waits after a wake until the Mac has been up a while", async () => {
  const wake = watchWake({ userActive: async () => false });
  let done = false;
  await wake.steady().then(() => (done = true));
  expect(done).toBe(true);
  // Asleep: the clock jumps with no ticks in between.
  vi.setSystemTime(Date.now() + 15 * 60_000);
  done = false;
  const waiting = wake.steady().then(() => (done = true));
  await vi.advanceTimersByTimeAsync(STEADY_MS - 10_000);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(15_000);
  await waiting;
  expect(done).toBe(true);
  wake.stop();
});

it("goes at once after a wake when someone is using the Mac", async () => {
  const wake = watchWake({ userActive: async () => true });
  vi.setSystemTime(Date.now() + 15 * 60_000);
  let done = false;
  await wake.steady().then(() => (done = true));
  expect(done).toBe(true);
  wake.stop();
});
