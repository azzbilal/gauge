/**
 * The two ways a call to the verify service fails. They are different facts and callers
 * must not treat them alike: an outage says nothing about the task, a contract error says
 * the service did answer and the answer cannot be trusted.
 */

/** No answer: the service could not be reached, or did not finish answering in time. */
export class VerifyUnreachableError extends Error {
  readonly name = 'VerifyUnreachableError';
}

/**
 * An answer that cannot be used: an error status (4xx or 5xx), a body that is not the
 * expected shape, or an extraction that does not match the rubric this API stores.
 */
export class VerifyContractError extends Error {
  readonly name = 'VerifyContractError';

  /** The HTTP status when the service answered with an error status; unset otherwise. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * POST /probe only: the verify service answered, but the model server behind it (Ollama)
 * could not produce a completion. The service says so with a 502. Like an outage, this
 * says nothing about the task, so it must never be read as a difficulty tier.
 */
export class ProbeModelUnreachableError extends Error {
  readonly name = 'ProbeModelUnreachableError';
}
