import type {
  RuntimeExecutionObservation,
  RuntimeExecutionObservationAdapter,
  RuntimeExecutionObservationRequest,
} from '../observation.js';

function copyObservation(observation: RuntimeExecutionObservation): RuntimeExecutionObservation {
  return { ...observation };
}

export class FakeRuntimeExecutionObservationAdapter
implements RuntimeExecutionObservationAdapter {
  private fixtures: RuntimeExecutionObservation[];
  private error: Error | null = null;
  private readonly captured: RuntimeExecutionObservationRequest[] = [];

  constructor(fixtures: readonly RuntimeExecutionObservation[] = []) {
    this.fixtures = fixtures.map(copyObservation);
  }

  get callCount(): number {
    return this.captured.length;
  }

  get requests(): readonly RuntimeExecutionObservationRequest[] {
    return this.captured.map(request => ({ ...request }));
  }

  setObservations(fixtures: readonly RuntimeExecutionObservation[]): void {
    this.fixtures = fixtures.map(copyObservation);
    this.error = null;
  }

  setError(error: Error): void {
    this.error = error;
  }

  async observe(
    request: RuntimeExecutionObservationRequest,
  ): Promise<readonly RuntimeExecutionObservation[]> {
    this.captured.push({ ...request });
    if (this.error) throw this.error;
    return this.fixtures.map(copyObservation);
  }
}
