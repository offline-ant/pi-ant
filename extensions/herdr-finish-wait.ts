import { HerdrApiError, HerdrFinishClient, type HerdrPane } from "./herdr-finish-client.ts";

export type FinishScope = "tab" | "space";
export interface FinishWaitOptions {
  endpoint: string;
  paneId: string;
  sessionRef: string;
  scope: FinishScope;
  signal: AbortSignal;
  progress: (pending: HerdrPane[]) => void;
  /** Deadline for observing the installed Pi integration's blocked report, not the overall wait. */
  blockedTimeoutMs?: number;
}

const LIFECYCLE_EVENTS = [
  "pane.created", "pane.closed", "pane.moved", "pane.exited", "pane.agent_detected",
  "tab.closed", "workspace.closed",
];

/** Events invalidate a fresh scope query; no historical completion or fixed dependency set. */
export async function waitForHerdrFinish(options: FinishWaitOptions): Promise<void> {
  const failure = new AbortController();
  const signal = AbortSignal.any([options.signal, failure.signal]);
  const client = new HerdrFinishClient(options.endpoint);
  let revision = 0;
  let wake: (() => void) | undefined;
  let closeLifecycle: (() => void) | undefined;
  let closeStatuses: (() => void) | undefined;
  let watchedIds = "";
  let caller: HerdrPane | undefined;
  let blockedObserved = false;
  const changed = () => { revision++; wake?.(); wake = undefined; };
  const failed = (error: Error) => failure.abort(error);
  const blockedTimeout = setTimeout(() => failed(new Error(
    "Herdr did not report this Pi as blocked. Enable the Herdr Pi state integration before waiting.",
  )), options.blockedTimeoutMs ?? 10_000);
  signal.addEventListener("abort", changed);

  try {
    signal.throwIfAborted();
    // Lifecycle coverage comes first, including panes not present in our initial snapshot.
    closeLifecycle = await client.subscribe(LIFECYCLE_EVENTS.map((type) => ({ type })), changed, failed, signal);
    while (true) {
      signal.throwIfAborted();
      const before = revision;
      const panes = await client.panes(signal);
      signal.throwIfAborted();
      const self = panes.find((pane) => pane.pane_id === options.paneId);
      if (!self || self.agent !== "pi" || self.agent_session?.value !== options.sessionRef) {
        throw new Error("Herdr caller no longer identifies this Pi session; wait cancelled");
      }
      if (caller && (caller.terminal_id !== self.terminal_id || caller.workspace_id !== self.workspace_id
        || (options.scope === "tab" && caller.tab_id !== self.tab_id))) {
        throw new Error("Herdr caller changed scope; wait cancelled");
      }
      caller = self;
      const scoped = panes.filter((pane) => pane.workspace_id === self.workspace_id
        && (options.scope === "space" || pane.tab_id === self.tab_id));
      const ids = scoped.map((pane) => pane.pane_id).sort();
      const key = JSON.stringify(ids);
      if (key !== watchedIds) {
        closeStatuses?.();
        closeStatuses = undefined;
        watchedIds = "";
        try {
          // Include shell panes: becoming an agent later must not create a status-observation gap.
          closeStatuses = await client.subscribe(ids.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
            changed, failed, signal);
          watchedIds = key;
        } catch (error) {
          if (!(error instanceof HerdrApiError) || !["pane_not_found", "terminal_not_found"].includes(error.code)) throw error;
          // A pane closed between listing and subscribing. Requery the live membership.
        }
        continue; // Always take a new snapshot after installing status subscriptions.
      }
      if (before !== revision) continue; // A change arrived while the snapshot was in flight.
      if (self.agent_status === "blocked") {
        blockedObserved = true;
        clearTimeout(blockedTimeout);
      } else if (blockedObserved) {
        throw new Error("Herdr lost this Pi's blocked state; wait cancelled");
      }
      const pending = scoped.filter((pane) => pane.pane_id !== self.pane_id && pane.agent
        && pane.agent_status !== "idle" && pane.agent_status !== "done");
      options.progress(pending);
      signal.throwIfAborted();
      if (blockedObserved && pending.length === 0) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    clearTimeout(blockedTimeout);
    signal.removeEventListener("abort", changed);
    closeStatuses?.();
    closeLifecycle?.();
  }
}
