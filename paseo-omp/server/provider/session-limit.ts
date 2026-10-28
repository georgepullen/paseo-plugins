import { DEFAULT_MAX_SESSIONS } from "../../shared/provider-launch-settings";

/**
 * Counts open sessions across every provider connection that shares this instance. The plugin
 * shares one instance between all of its OMP providers, so the limit applies to the whole host.
 */
export class OmpSessionLimit {
  private readonly counts = new Set<() => number>();
  maxSessions = DEFAULT_MAX_SESSIONS;

  /** `readConfigured` returns the configured limit, or `undefined` to keep the current one. */
  constructor(private readonly readConfigured?: () => Promise<number | undefined>) {}

  async refresh(): Promise<void> {
    const configured = await this.readConfigured?.();
    if (configured !== undefined) this.maxSessions = configured;
  }

  /** Adds a connection's open sessions to the total until the returned function runs. */
  track(count: () => number): () => void {
    this.counts.add(count);
    return () => {
      this.counts.delete(count);
    };
  }

  get openSessions(): number {
    let total = 0;
    for (const count of this.counts) total += count();
    return total;
  }
}
