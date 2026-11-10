import { Injectable, Logger } from '@nestjs/common';

export interface LowConfidenceAlert {
  runId: string;
  expertName: string;
  postingTitle: string;
  confidence: number;
  needsReview: boolean;
}

const SLACK_TIMEOUT_MS = 5000;

/**
 * Posts reviewer alerts to a Slack incoming webhook.
 * Never throws: an alert failure must not fail or stall the intake run.
 */
@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);

  async alertLowConfidence(payload: LowConfidenceAlert): Promise<void> {
    const text = [
      `:warning: Low-confidence intake run needs review`,
      `*Expert:* ${payload.expertName}`,
      `*Posting:* ${payload.postingTitle}`,
      `*Confidence:* ${payload.confidence.toFixed(2)}`,
      `*Needs review:* ${payload.needsReview ? 'yes' : 'no'}`,
      `*Run:* ${payload.runId}`,
    ].join('\n');

    const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      this.logger.log(`Slack (dry run, SLACK_WEBHOOK_URL not set): ${text.replace(/\n/g, ' | ')}`);
      return;
    }

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`Slack webhook returned ${res.status} for run ${payload.runId}`);
      }
    } catch (err) {
      this.logger.warn(
        `Slack webhook failed for run ${payload.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
