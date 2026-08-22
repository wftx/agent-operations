import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResult,
  RuntimeExecutionAdapter,
} from '../dispatch.js';

function copyRequest(request: RuntimeDispatchRequest): RuntimeDispatchRequest {
  return { ...request, input: { ...request.input } };
}

export class FakeRuntimeExecutionAdapter implements RuntimeExecutionAdapter {
  private result: RuntimeDispatchResult;
  private error: Error | null = null;
  private readonly captured: RuntimeDispatchRequest[] = [];

  constructor(result: RuntimeDispatchResult = { status: 'accepted' }) {
    this.result = { ...result };
  }

  get callCount(): number {
    return this.captured.length;
  }

  get requests(): readonly RuntimeDispatchRequest[] {
    return this.captured.map(copyRequest);
  }

  setResult(result: RuntimeDispatchResult): void {
    this.result = { ...result };
    this.error = null;
  }

  setError(error: Error): void {
    this.error = error;
  }

  async dispatch(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResult> {
    this.captured.push(copyRequest(request));
    if (this.error) throw this.error;
    return { ...this.result };
  }
}
