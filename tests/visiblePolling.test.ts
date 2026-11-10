import assert from "node:assert/strict";
import test from "node:test";
import {
  startVisiblePolling,
  type PollingClock,
  type VisibilitySource,
} from "../web/src/visiblePolling.ts";

class FakeVisibility implements VisibilitySource {
  visibilityState = "visible";
  listeners = new Set<() => void>();
  addEventListener(_type: "visibilitychange", listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "visibilitychange", listener: () => void) {
    this.listeners.delete(listener);
  }
  change(next: string) {
    this.visibilityState = next;
    for (const listener of this.listeners) listener();
  }
}

class FakeClock implements PollingClock {
  next = 0;
  timers = new Map<number, () => void>();
  cleared: number[] = [];
  setInterval(callback: () => void, _intervalMs: number): unknown {
    const handle = ++this.next;
    this.timers.set(handle, callback);
    return handle;
  }
  clearInterval(handle: unknown): void {
    this.cleared.push(Number(handle));
    this.timers.delete(Number(handle));
  }
  tick() {
    for (const callback of [...this.timers.values()]) callback();
  }
}

test("可见页签立即同步并保持周期轮询", () => {
  const page = new FakeVisibility();
  const clock = new FakeClock();
  let polls = 0;
  const stop = startVisiblePolling(() => { polls += 1; }, 1500, page, { clock });
  assert.equal(polls, 1);
  assert.equal(clock.timers.size, 1);
  clock.tick();
  assert.equal(polls, 2);
  stop();
  assert.equal(clock.timers.size, 0);
  assert.equal(page.listeners.size, 0);
});

test("隐藏页签不空转，回到前台立即补一次且只留一个定时器", () => {
  const page = new FakeVisibility();
  const clock = new FakeClock();
  let polls = 0;
  const stop = startVisiblePolling(() => { polls += 1; }, 5000, page, { clock });
  page.change("hidden");
  assert.equal(clock.timers.size, 0);
  clock.tick();
  assert.equal(polls, 1);
  page.change("visible");
  assert.equal(polls, 2);
  assert.equal(clock.timers.size, 1);
  page.change("visible");
  assert.equal(polls, 3);
  assert.equal(clock.timers.size, 1);
  stop();
});

test("初始隐藏不请求；纯刷新信号可选择不在挂载时额外触发", () => {
  const page = new FakeVisibility();
  const clock = new FakeClock();
  let polls = 0;
  page.visibilityState = "hidden";
  const stop = startVisiblePolling(() => { polls += 1; }, 5000, page, {
    clock,
    runOnStart: false,
  });
  assert.equal(polls, 0);
  assert.equal(clock.timers.size, 0);
  page.change("visible");
  assert.equal(polls, 1);
  clock.tick();
  assert.equal(polls, 2);
  stop();
});
