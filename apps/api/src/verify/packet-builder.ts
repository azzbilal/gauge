import { CRITERIA } from '../campaign/review-protocol';

/**
 * Turns a task (prompt, spec, reference) into the packet the verify service reads
 * (verify/lint/packet.py).
 *
 * Nothing is extracted here. The requirements a task states and the check method of each
 * rubric item come from the verify service (POST /extract, verify/lint/extract.py), which
 * is the one place prose is parsed; this file asks for them and arranges the answer into
 * rows to store and a packet to lint and verify. No database.
 */

export type PacketCheckMethod = 'machine' | 'manual';

export interface PacketRequirement {
  id: string;
  text: string;
  kind: string;
  value: string | null;
  tolerance: string | null;
}

export interface PacketRubricItem {
  id: string;
  text: string;
  requirementId: string | null;
  checkMethod: PacketCheckMethod;
  weight: number;
}

export interface TaskPacket {
  prompt: string;
  spec: string;
  reference: string;
  requirements: PacketRequirement[];
  rubricItems: PacketRubricItem[];
}

export interface BuiltPacket {
  /** One per requirement the service found; stored as Requirement rows. */
  requirements: PacketRequirement[];
  /** One per review criterion; stored as RubricItem rows. */
  rubricItems: PacketRubricItem[];
  /**
   * What is sent to the verify service. Same requirements; a machine rubric item is
   * repeated once per requirement it checks (id `<rubricItemId>:<requirementId>`), because
   * the verifier checks exactly one requirement per rubric item.
   */
  packet: TaskPacket;
  /** The version of the extraction that produced the requirements. */
  extractionVersion: string;
}

export interface PacketSource {
  prompt: string;
  spec?: string | null;
  reference?: string | null;
}

// --------------------------------------------------------------------------- extraction

/** One rubric item as POST /extract answers it. */
export interface ExtractedRubricItem {
  id: string;
  /** The review criterion the item scores; its text opens with it. */
  criterion: string;
  text: string;
  checkMethod: PacketCheckMethod;
  /** The requirements a machine item is checked against; empty for a manual one. */
  requirementIds: string[];
  weight: number;
}

/** The answer of POST /extract. */
export interface Extraction {
  version: string;
  requirements: PacketRequirement[];
  rubricItems: ExtractedRubricItem[];
}

/** Whoever can reach POST /extract; VerifyClient in the running API. */
export interface RequirementExtractor {
  extract(source: { prompt: string; spec: string | null }): Promise<Extraction>;
}

/** Recover the stored RubricItem id from a rubric item id in a verify-service answer. */
export function rubricItemIdOf(packetItemId: string): string {
  return packetItemId.split(':')[0];
}

/**
 * Ask the verify service what the task requires and build its packet. Rejects when the
 * service cannot be reached or its answer cannot be used: there is no local fallback, so
 * the caller has no packet and must record that nothing was linted or verified.
 */
export async function buildPacket(
  task: PacketSource,
  extractor: RequirementExtractor,
): Promise<BuiltPacket> {
  const extraction = await extractor.extract({ prompt: task.prompt, spec: task.spec ?? null });
  const { requirements } = extraction;
  const known = new Map(requirements.map((r) => [r.id, r]));

  // The stored rubric is one row per review criterion, in order. An answer that is not
  // exactly that is from a service this API does not match.
  const criteria = extraction.rubricItems.map((i) => i.criterion);
  if (criteria.length !== CRITERIA.length || CRITERIA.some((c, i) => criteria[i] !== c)) {
    throw new Error(
      `verify service /extract returned rubric items for [${criteria.join(', ')}], ` +
        `expected [${CRITERIA.join(', ')}]`,
    );
  }

  const checked = extraction.rubricItems.map((item) => {
    if (item.checkMethod !== 'machine') return [];
    const linked = item.requirementIds.map((id) => known.get(id));
    if (linked.length === 0 || linked.some((r) => r === undefined)) {
      throw new Error(
        `verify service /extract returned machine rubric item "${item.criterion}" ` +
          'without requirements it can be checked against',
      );
    }
    return linked as PacketRequirement[];
  });

  const rubricItems: PacketRubricItem[] = extraction.rubricItems.map((item, i) => ({
    id: item.id,
    text: item.text,
    // A row holds one requirement id; with several requirements the links are in the packet.
    requirementId: checked[i].length === 1 ? checked[i][0].id : null,
    checkMethod: item.checkMethod,
    weight: item.weight,
  }));

  const packetItems = rubricItems.flatMap((item, i) =>
    item.checkMethod === 'machine'
      ? checked[i].map((req) => ({
          ...item,
          id: `${item.id}:${req.id}`,
          text: `${item.text} (${req.text})`,
          requirementId: req.id,
          weight: item.weight / checked[i].length,
        }))
      : [item],
  );

  return {
    requirements,
    rubricItems,
    packet: {
      prompt: task.prompt,
      spec: task.spec ?? '',
      reference: task.reference ?? '',
      requirements,
      rubricItems: packetItems,
    },
    extractionVersion: extraction.version,
  };
}
