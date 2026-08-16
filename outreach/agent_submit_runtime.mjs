// agent_submit_runtime.mjs — 动作结果结构化与看门狗预算(2026-08-16 从生产 agent_submit_runtime.js 原样移植,仅改 ESM)

const ROLLING_HARD_KILL_MS = 900000;
const WATCHDOG_SAFETY_MARGIN_MS = 20000;
const WATCHDOG_ENQUEUE_BACKOFF_MS = 5000;
const WATCHDOG_UPSERT_ATTEMPTS = 1;
const WATCHDOG_ENQUEUE_ATTEMPTS = 2;
const WATCHDOG_DB_READS = 2;

export function actionResult(text, submitClass = false, dispatched = false) {
  return {
    text: String(text == null ? '' : text),
    submitClass: Boolean(submitClass),
    dispatched: Boolean(dispatched),
  };
}

export function normalizeActionResult(value) {
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return actionResult(value.text, value.submitClass, value.dispatched);
  }
  return actionResult(value);
}

export function shouldObserveSubmit(result) {
  return Boolean(result && result.submitClass && !result.dispatched);
}

export function shouldTrackSubmitNoDelta(result) {
  return Boolean(result && result.submitClass && result.dispatched);
}

export function makeWatchdogPlan(maxMinutes, busyTimeoutMs) {
  const minutes = Number(maxMinutes);
  const busy = Number(busyTimeoutMs);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('watchdog: maxMinutes 必须为正数');
  if (!Number.isFinite(busy) || busy <= 0) throw new Error('watchdog: busyTimeoutMs 必须为正数');

  // 最坏尾段:两次只读 + 一次终局 upsert + 两次人工任务入队，另含一次 5s 退避。
  const finalizeWorstMs = busy * (
    WATCHDOG_DB_READS + WATCHDOG_UPSERT_ATTEMPTS + WATCHDOG_ENQUEUE_ATTEMPTS
  ) + WATCHDOG_ENQUEUE_BACKOFF_MS * (WATCHDOG_ENQUEUE_ATTEMPTS - 1);
  const latestTriggerMs = ROLLING_HARD_KILL_MS - finalizeWorstMs
    - WATCHDOG_SAFETY_MARGIN_MS - 1;
  const triggerMs = Math.min((minutes + 2) * 60000, latestTriggerMs);
  const worstCaseMs = triggerMs + finalizeWorstMs;
  if (worstCaseMs + WATCHDOG_SAFETY_MARGIN_MS >= ROLLING_HARD_KILL_MS) {
    throw new Error('watchdog: 收尾预算不得撞上 rolling 900s 硬杀');
  }
  return {
    triggerMs,
    worstCaseMs,
    hardKillMs: ROLLING_HARD_KILL_MS,
    safetyMarginMs: WATCHDOG_SAFETY_MARGIN_MS,
    upsertAttempts: WATCHDOG_UPSERT_ATTEMPTS,
    enqueueAttempts: WATCHDOG_ENQUEUE_ATTEMPTS,
    enqueueBackoffMs: WATCHDOG_ENQUEUE_BACKOFF_MS,
  };
}
