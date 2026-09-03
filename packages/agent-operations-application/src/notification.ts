export type OperatorNotificationEvent =
  | {
      readonly kind: 'job_completed';
      readonly jobId: string;
      readonly title: string;
      readonly projectName?: string;
      readonly aoPath?: string;
      readonly result: string;
      readonly reviewerSummary: string;
      readonly workerAttemptCount: number;
    }
  | {
      readonly kind: 'needs_human';
      readonly jobId: string;
      readonly escalationId: string;
      readonly title: string;
      readonly projectName?: string;
      readonly aoPath?: string;
      readonly reason: string;
      readonly reviewerFeedback?: string;
    };

export interface OperatorNotificationResult {
  readonly status: 'sent' | 'skipped';
  readonly message?: string;
}

/** Provider-neutral delivery port. Notification delivery never owns Job truth. */
export interface OperatorNotifier {
  notify(event: OperatorNotificationEvent): Promise<OperatorNotificationResult>;
}

export class NoopOperatorNotifier implements OperatorNotifier {
  async notify(): Promise<OperatorNotificationResult> {
    return { status: 'skipped', message: 'Operator notifications are not configured.' };
  }
}
