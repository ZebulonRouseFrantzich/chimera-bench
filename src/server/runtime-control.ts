interface ActiveRunCanceller {
  (reason: string): Promise<void> | void;
}

interface EngineProcessHandle {
  stop(reason: string): Promise<void> | void;
}

interface SseStreamHandle {
  close(reason: string): void;
}

export class RuntimeControl {
  private acceptingNewRuns = true;
  private activeRunCanceller: ActiveRunCanceller | null = null;
  private readonly engineProcesses = new Set<EngineProcessHandle>();
  private readonly sseStreams = new Set<SseStreamHandle>();

  stopAcceptingNewRuns(): void {
    this.acceptingNewRuns = false;
  }

  isAcceptingNewRuns(): boolean {
    return this.acceptingNewRuns;
  }

  setActiveRunCanceller(canceller: ActiveRunCanceller): () => void {
    this.activeRunCanceller = canceller;

    return () => {
      if (this.activeRunCanceller === canceller) {
        this.activeRunCanceller = null;
      }
    };
  }

  async cancelActiveRun(reason: string): Promise<void> {
    if (!this.activeRunCanceller) {
      return;
    }

    await this.activeRunCanceller(reason);
    this.activeRunCanceller = null;
  }

  registerEngineProcess(handle: EngineProcessHandle): () => void {
    this.engineProcesses.add(handle);

    return () => {
      this.engineProcesses.delete(handle);
    };
  }

  async cleanupEngineSubprocesses(reason: string): Promise<void> {
    const processHandles = Array.from(this.engineProcesses);
    this.engineProcesses.clear();

    await Promise.allSettled(
      processHandles.map((handle) => Promise.resolve(handle.stop(reason))),
    );
  }

  registerSseStream(handle: SseStreamHandle): () => void {
    this.sseStreams.add(handle);

    return () => {
      this.sseStreams.delete(handle);
    };
  }

  closeSseStreams(reason: string): void {
    for (const stream of this.sseStreams) {
      try {
        stream.close(reason);
      } catch {
        // Ignore individual stream close errors during shutdown.
      }
    }

    this.sseStreams.clear();
  }
}
