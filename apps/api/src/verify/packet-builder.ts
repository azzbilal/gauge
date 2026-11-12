import { randomUUID } from 'node:crypto';
import { CRITERIA, Criterion } from '../campaign/review-protocol';

/**
 * Turns a task (prompt, spec, reference) into the packet the verify service reads
 * (verify/lint/packet.py). Pure: no database, no network.
 *
 * Requirements are the millimetre dimensions found in the spec. Rubric items are the five
 * review criteria; `correct_reference` is the dimension-related one and is machine-checked
 * whenever the spec states a dimension the verifier can name, everything else is manual.
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
  /** One per dimension found in the spec; stored as Requirement rows. */
  requirements: PacketRequirement[];
  /** The five default rubric items; stored as RubricItem rows. */
  rubricItems: PacketRubricItem[];
  /**
   * What is sent to the verify service. Same requirements; the machine rubric item is
   * repeated once per nameable dimension (id `<rubricItemId>:<requirementId>`), because
   * the verifier checks exactly one requirement per rubric item.
   */
  packet: TaskPacket;
}

export interface PacketSource {
  prompt: string;
  spec?: string | null;
  reference?: string | null;
}

// ---------------------------------------------------------------- requirement extraction

const NUM = String.raw`(?<![\w.])\d+(?:\.\d+)?`;
const PLAIN_NUM = String.raw`\d+(?:\.\d+)?`;
const TOL = String.raw`(?:\s*(?:±|\+\/-|\+-)\s*(\d+(?:\.\d+)?))?`;
const MM = String.raw`mm(?![\w^²³])`;
const OTHER_UNIT = String.raw`(?!\s*(?:cm|m|um|µm|inch|inches|deg|kg|g)\b)`;
const NOUNS = 'width|length|height|depth|thickness|diameter|dia|radius';
const ADJECTIVES = `wide|long|tall|high|deep|thick|${NOUNS}`;
// Words that scope a size to a feature, mirroring _QUALIFIERS in verify/lint/rules.py.
// They stay in the requirement text so the verifier does not mistake, say, a fillet
// radius for a hole radius or a hole depth for the depth of the part.
const QUALIFIER_WORDS = [
  'hole', 'bore', 'slot', 'wall', 'base', 'flange', 'plate', 'pin', 'shaft', 'boss', 'rib',
  'pocket', 'thread', 'trace', 'pad', 'via', 'board', 'groove', 'counterbore', 'tube', 'pipe',
  'cylinder', 'body', 'fillet', 'chamfer', 'corner', 'edge', 'inner', 'inside', 'internal',
  'outer', 'outside', 'external', 'major', 'minor', 'top', 'bottom', 'mounting', 'through',
  'input', 'output', 'supply', 'load', 'cutoff',
];
const QUALIFIER_SYNONYMS: Record<string, string> = {
  inside: 'inner',
  internal: 'inner',
  outside: 'outer',
  external: 'outer',
};
const QUALIFIER = `(?:${QUALIFIER_WORDS.join('|')})s?`;

// "60 x 40 x 5 mm", "60 mm x 40 mm x 5 mm", "60x40x5"
const TRIPLE = new RegExp(
  String.raw`(${NUM})(?:\s*mm)?\s*[x×]\s*(${PLAIN_NUM})(?:\s*mm)?\s*[x×]\s*(${PLAIN_NUM})(?!\.?\d)(?:\s*${MM}|${OTHER_UNIT})`,
  'gi',
);
// "diameter 8 mm", "hole diameter: 8 mm", "width of 60 ± 0.1 mm"
const LABEL_FIRST = new RegExp(
  String.raw`\b((?:${QUALIFIER}[\s-]+){0,2})(${NOUNS})\b\.?\s*(?:of|is|=|:)?\s*(${NUM})${TOL}\s*${MM}`,
  'gi',
);
// "60 mm wide", "5 mm diameter holes", "holes 5 mm deep"
const VALUE_FIRST = new RegExp(
  String.raw`(?:\b((?:${QUALIFIER}\s+){1,2})(?:of\s+|with\s+)?)?(${NUM})${TOL}\s*${MM}[\s-]*(${ADJECTIVES})\b((?:\s+${QUALIFIER}\b){1,2})?`,
  'gi',
);
// "60 mm" with nothing saying what it measures
const BARE = new RegExp(String.raw`(${NUM})${TOL}\s*${MM}`, 'gi');

const NOUN_OF: Record<string, string> = {
  wide: 'width',
  long: 'length',
  tall: 'height',
  high: 'height',
  deep: 'depth',
  thick: 'thickness',
  dia: 'diameter',
};

interface Found {
  at: number;
  /** What the number measures ("hole diameter"); null when the spec does not say. */
  label: string | null;
  value: string;
  tolerance: string | null;
  /** Position (0, 1, 2) within an "A x B x C" triple. */
  axis?: number;
}

function findDimensions(spec: string): Found[] {
  const found: Found[] = [];
  const claimed: Array<[number, number]> = [];
  // Most specific pattern first; a later pattern never re-reads a claimed span.
  const scan = (pattern: RegExp, read: (m: RegExpExecArray) => Array<Omit<Found, 'at'>>) => {
    for (const m of spec.matchAll(pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      read(m).forEach((f, i) => found.push({ ...f, at: start + i / 10 }));
    }
  };
  const label = (qualifierRun: string | undefined, word: string) => {
    const qualifiers = (qualifierRun ?? '')
      .toLowerCase()
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((w) => (QUALIFIER_WORDS.includes(w) ? w : w.replace(/s$/, '')))
      .map((w) => QUALIFIER_SYNONYMS[w] ?? w);
    const noun = NOUN_OF[word.toLowerCase()] ?? word.toLowerCase();
    return [...qualifiers, noun].join(' ');
  };
  const tolerance = (t: string | undefined) => (t ? `±${t} mm` : null);

  scan(TRIPLE, (m) =>
    [m[1], m[2], m[3]].map((n, axis) => ({ label: null, value: n, tolerance: null, axis })),
  );
  scan(LABEL_FIRST, (m) => [{ label: label(m[1], m[2]), value: m[3], tolerance: tolerance(m[4]) }]);
  scan(VALUE_FIRST, (m) => [
    { label: label(m[5]?.trim() ? m[5] : m[1], m[4]), value: m[2], tolerance: tolerance(m[3]) },
  ]);
  scan(BARE, (m) => [{ label: null, value: m[1], tolerance: tolerance(m[2]) }]);

  // Name the three sizes of "A x B x C" the way the verifier maps names to axes
  // (verify/verifiers/verifiers.py): X, Y, Z are length, width, height when the spec
  // speaks of a "length" anywhere, and width, depth, height when it does not.
  const usesLength = found.some((f) => f.label?.split(' ').pop() === 'length');
  const axes = usesLength ? ['length', 'width', 'height'] : ['width', 'depth', 'height'];
  for (const f of found) {
    if (f.axis !== undefined) f.label = axes[f.axis];
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The millimetre dimensions a spec states, one requirement each, in reading order. */
export function extractRequirements(spec: string | null | undefined): PacketRequirement[] {
  return extract(spec).map(({ requirement }) => requirement);
}

function extract(spec: string | null | undefined) {
  const seen = new Set<string>();
  const out: Array<{ requirement: PacketRequirement; nameable: boolean }> = [];
  for (const f of findDimensions(spec ?? '')) {
    const value = `${f.value} mm`;
    const text = f.label ? `${f.label} of ${value}` : value;
    const key = `${text}|${f.tolerance ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      requirement: { id: randomUUID(), text, kind: 'dimension', value, tolerance: f.tolerance },
      nameable: f.label !== null,
    });
  }
  return out;
}

// ------------------------------------------------------------------------- rubric items

// The wording matters: the linter re-infers the check method from the words dimension,
// hole, volume and manifold (verify/lint/rules.py), so only a machine item may use them.
const MANUAL_TEXT: Record<Criterion, string> = {
  verifiable: 'verifiable: the result can be checked objectively against the spec.',
  unambiguous: 'unambiguous: two solvers would read the spec the same way.',
  correct_reference: 'correct_reference: the reference solution satisfies the spec.',
  complete_constraints:
    'complete_constraints: sizes and tolerances are fully specified, with no free parameters.',
  difficulty: 'difficulty: the task is hard enough to be worth solving.',
};
const MACHINE_TEXT: Partial<Record<Criterion, string>> = {
  correct_reference:
    'correct_reference: the reference solution has every dimension the spec states.',
};

/** Recover the stored RubricItem id from a rubric item id in a verify-service answer. */
export function rubricItemIdOf(packetItemId: string): string {
  return packetItemId.split(':')[0];
}

export function buildPacket(task: PacketSource): BuiltPacket {
  const extracted = extract(task.spec);
  const requirements = extracted.map((e) => e.requirement);
  // Only a dimension with a name ("width of 60 mm") can be compared with the reference.
  const checkable = extracted.filter((e) => e.nameable).map((e) => e.requirement);

  const rubricItems: PacketRubricItem[] = CRITERIA.map((criterion) => {
    const machineText = checkable.length > 0 ? MACHINE_TEXT[criterion] : undefined;
    return {
      id: randomUUID(),
      text: machineText ?? MANUAL_TEXT[criterion],
      // A row holds one requirement id; with several dimensions the links are in the packet.
      requirementId: machineText && checkable.length === 1 ? checkable[0].id : null,
      checkMethod: machineText ? 'machine' : 'manual',
      weight: 1,
    };
  });

  const packetItems = rubricItems.flatMap((item) =>
    item.checkMethod === 'machine'
      ? checkable.map((req) => ({
          ...item,
          id: `${item.id}:${req.id}`,
          text: `${item.text} (${req.text})`,
          requirementId: req.id,
          weight: item.weight / checkable.length,
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
  };
}
