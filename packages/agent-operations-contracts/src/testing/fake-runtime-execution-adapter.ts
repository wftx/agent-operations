import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResult,
  RuntimeExecutionAdapter,
} from '../dispatch.js';

function copyRequest(request: RuntimeDispatchRequest): RuntimeDispatchRequest {
  return {
    ...request,
    input: { ...request.input },
    requestedPolicy: { ...request.requestedPolicy },
    requestedCapabilities: { ...request.requestedCapabilities },
    ...(request.executionContext
      ? { executionContext: { ...request.executionContext } }
      : {}),
  };
}

export class FakeRuntimeExecutionAdapter implements RuntimeExecutionAdapter {
  private result: RuntimeDispatchResult;
  private error: Error | null = null;
  private readonly captured: RuntimeDispatchRequest[] = [];
  private submitted = 0;

  constructor(result: RuntimeDispatchResult = { status: 'accepted' }) {
    this.result = { ...result };
  }

  get callCount(): number {
    return this.captured.length;
  }

  get requests(): readonly RuntimeDispatchRequest[] {
    return this.captured.map(copyRequest);
  }

  get submissionCount(): number {
    return this.submitted;
  }

  setResult(result: RuntimeDispatchResult): void {
    this.result = { ...result };
    this.error = null;
  }

  setError(error: Error): void {
    this.error = error;
  }

  rejectUnsupportedPolicy(message = 'Fake runtime cannot enforce the requested policy'): void {
    this.setResult({ status: 'rejected', code: 'POLICY_UNSUPPORTED', message });
  }

  rejectPolicyConflict(message = 'Fake runtime session conflicts with the requested policy'): void {
    this.setResult({ status: 'rejected', code: 'POLICY_MISMATCH', message });
  }

  acceptWithEffectivePolicy(policy: RuntimeDispatchResult['effectivePolicy']): void {
    if (!policy) throw new Error('Fake effective policy is required');
    this.setResult({ status: 'accepted', effectivePolicy: { ...policy } });
  }

  async dispatch(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResult> {
    this.captured.push(copyRequest(request));
    if (this.error) throw this.error;
    if (this.result.status === 'rejected'
      && (this.result.code === 'POLICY_UNSUPPORTED' || this.result.code === 'POLICY_MISMATCH')) {
      return { ...this.result };
    }
    this.submitted += 1;
    if (this.result.status === 'accepted') {
      return {
        ...this.result,
        effectivePolicy: this.result.effectivePolicy
          ? { ...this.result.effectivePolicy }
          : { ...request.requestedPolicy },
        effectiveCapabilities: this.result.effectiveCapabilities
          ? { ...this.result.effectiveCapabilities }
          : { ...request.requestedCapabilities },
      };
    }
    return {
      ...this.result,
      ...(this.result.effectivePolicy
        ? { effectivePolicy: { ...this.result.effectivePolicy } }
        : {}),
      ...(this.result.effectiveCapabilities
        ? { effectiveCapabilities: { ...this.result.effectiveCapabilities } }
        : {}),
    };
  }
}
