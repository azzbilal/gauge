/**
 * Verifier agreement with human verdicts (Gate 2, docs/PRD.md) as pure functions.
 *
 * For every decided task, the human decision (ACCEPTED / REJECTED, after consensus or
 * adjudication) is set against the verifier's overall result on the task's reference: the
 * stored VerifierRun's `passed`, which is true only when every machine verdict passed. A
 * verdict that did not run counts as not passed, exactly as the stored run says; the
 * disagreement list shows which verdicts those were.
 *
 * A decided task with no stored verifier run is not a verifier fail: it is counted apart
 * (`unverified`) and left out of the rate. No database, no framework.
 */

export interface VerifierAgreementInput {
  taskId: string;
  /** The human decision: true for ACCEPTED, false for REJECTED. */
  humanAccepted: boolean;
  /** The verifier's overall result on the reference; null when no run was stored. */
  verifierPassed: boolean | null;
}

/** Rows are the human decision, columns the verifier's result. */
export interface VerifierConfusion {
  /** Human accepted, verifier passed. */
  acceptedPassed: number;
  /** Human accepted, verifier did not pass (a false fail). */
  acceptedFailed: number;
  /** Human rejected, verifier passed (a false pass: the costly error for a reward). */
  rejectedPassed: number;
  /** Human rejected, verifier did not pass. */
  rejectedFailed: number;
}

export interface VerifierAgreementStats {
  /** Decided tasks considered, with or without a verifier run. */
  decidedTasks: number;
  /** Decided tasks with a verifier run: the denominator of the rate. */
  compared: number;
  /** Decided tasks with no verifier run; not in the rate. */
  unverified: number;
  agreed: number;
  /** agreed / compared; null when nothing could be compared. */
  agreementRate: number | null;
  /**
   * Cohen's kappa: agreement beyond what the two marginals give by chance. Null when it is
   * undefined (nothing compared, or both sides gave one answer throughout).
   */
  cohenKappa: number | null;
  confusion: VerifierConfusion;
  /** Of the tasks humans rejected, the share the verifier passed; null with none rejected. */
  falsePassRate: number | null;
  /** Of the tasks humans accepted, the share the verifier did not pass; null with none accepted. */
  falseFailRate: number | null;
}

export type Disagreement = 'false_pass' | 'false_fail';

/** How a compared task's verifier result relates to the human decision; null when they agree. */
export function disagreementOf(row: VerifierAgreementInput): Disagreement | null {
  if (row.verifierPassed === null || row.verifierPassed === row.humanAccepted) return null;
  return row.verifierPassed ? 'false_pass' : 'false_fail';
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function verifierAgreementStats(rows: VerifierAgreementInput[]): VerifierAgreementStats {
  const confusion: VerifierConfusion = {
    acceptedPassed: 0,
    acceptedFailed: 0,
    rejectedPassed: 0,
    rejectedFailed: 0,
  };
  let unverified = 0;
  for (const row of rows) {
    if (row.verifierPassed === null) {
      unverified++;
    } else if (row.humanAccepted) {
      if (row.verifierPassed) confusion.acceptedPassed++;
      else confusion.acceptedFailed++;
    } else if (row.verifierPassed) {
      confusion.rejectedPassed++;
    } else {
      confusion.rejectedFailed++;
    }
  }
  const { acceptedPassed, acceptedFailed, rejectedPassed, rejectedFailed } = confusion;
  const compared = acceptedPassed + acceptedFailed + rejectedPassed + rejectedFailed;
  const agreed = acceptedPassed + rejectedFailed;

  let cohenKappa: number | null = null;
  if (compared > 0) {
    const observed = agreed / compared;
    const humanAccept = (acceptedPassed + acceptedFailed) / compared;
    const verifierPass = (acceptedPassed + rejectedPassed) / compared;
    const chance = humanAccept * verifierPass + (1 - humanAccept) * (1 - verifierPass);
    cohenKappa = chance === 1 ? null : (observed - chance) / (1 - chance);
  }

  return {
    decidedTasks: rows.length,
    compared,
    unverified,
    agreed,
    agreementRate: ratio(agreed, compared),
    cohenKappa,
    confusion,
    falsePassRate: ratio(rejectedPassed, rejectedPassed + rejectedFailed),
    falseFailRate: ratio(acceptedFailed, acceptedPassed + acceptedFailed),
  };
}
