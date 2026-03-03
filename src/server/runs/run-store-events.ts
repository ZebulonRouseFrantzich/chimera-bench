import {
  MAX_EVENTS_PER_RUN,
  type RunEventListener,
  type RunEventName,
  type RunEventRecord,
} from "./run-store-types.ts";

export class RunStoreEvents {
  private readonly runEvents = new Map<string, RunEventRecord[]>();
  private readonly runEventListeners = new Map<string, Set<RunEventListener>>();

  listRunEvents(runId: string): RunEventRecord[] {
    return [...(this.runEvents.get(runId) ?? [])];
  }

  subscribeRunEvents(
    runId: string,
    listener: RunEventListener,
    hasRun: (runId: string) => boolean,
  ): () => void {
    if (!hasRun(runId)) {
      return () => {
        return;
      };
    }

    const listeners = this.runEventListeners.get(runId) ?? new Set<RunEventListener>();
    listeners.add(listener);
    this.runEventListeners.set(runId, listeners);

    return () => {
      const activeListeners = this.runEventListeners.get(runId);
      if (!activeListeners) {
        return;
      }

      activeListeners.delete(listener);
      if (activeListeners.size === 0) {
        this.runEventListeners.delete(runId);
      }
    };
  }

  emitRunEvent(
    runId: string,
    event: RunEventName,
    payload: Record<string, unknown>,
    hasRun: (runId: string) => boolean,
  ): void {
    if (!hasRun(runId)) {
      return;
    }

    const record: RunEventRecord = {
      event,
      payload: {
        runId,
        ...payload,
      },
    };

    const events = this.runEvents.get(runId) ?? [];
    events.push(record);
    if (events.length > MAX_EVENTS_PER_RUN) {
      events.splice(0, events.length - MAX_EVENTS_PER_RUN);
    }
    this.runEvents.set(runId, events);

    const listeners = this.runEventListeners.get(runId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const activeListener of listeners) {
      try {
        activeListener(record);
      } catch {
        // Listener failures should not interrupt run state transitions.
      }
    }
  }

  deleteRun(runId: string): void {
    this.runEvents.delete(runId);
    this.runEventListeners.delete(runId);
  }
}
