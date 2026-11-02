/**
 * What a provider failure means, so a retired model ID or a dead account is not treated like an outage.
 */

export type FailureClass = 'model_gone' | 'auth' | 'rate' | 'server' | 'other';

/** Sorts a failed call by what it says about the provider, the model or the moment. */
export function classifyFailure(status: number | undefined, message: string): FailureClass {
  if (status === 400 || status === 404 || status === 410) {
    if (/not a valid model|invalid model|unknown model|model\b[^.]{0,40}\b(?:not found|unavailable|does not exist|not available|not supported|deprecated|retired)|end of life|no longer available/i.test(message)) {
      return 'model_gone';
    }
  }
  if (status === 401 || status === 402 || status === 403) {
    return 'auth';
  }
  if (status === 429) {
    return 'rate';
  }
  if (status === undefined || status >= 500) {
    return 'server';
  }
  return 'other';
}

/** Remembers which models are gone and which providers refuse our credentials. */
export class FailureLedger {
  private disabledModels = new Map<string, number>();
  private blockedProviders = new Map<string, number>();

  record(providerId: string, modelId: string, status: number | undefined, message: string, now = Date.now()): FailureClass {
    const kind = classifyFailure(status, message);
    if (kind === 'model_gone') {
      this.disabledModels.set(`${providerId}::${modelId}`, now + 24 * 3600_000);
    } else if (kind === 'auth') {
      this.blockedProviders.set(providerId, now + 30 * 60_000);
    }
    return kind;
  }

  isModelDisabled(providerId: string, modelId: string, now = Date.now()): boolean {
    return now < (this.disabledModels.get(`${providerId}::${modelId}`) ?? 0);
  }

  isProviderBlocked(providerId: string, now = Date.now()): boolean {
    return now < (this.blockedProviders.get(providerId) ?? 0);
  }

  recordSuccess(providerId: string): void {
    this.blockedProviders.delete(providerId);
  }
}
