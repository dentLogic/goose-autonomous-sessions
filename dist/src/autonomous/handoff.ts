// src/lib/autonomous/handoff.ts
// Spec sections 4, 5, 6, 23, 24, 25, 26, 51, 52, 53, 54, 78.
import { HANDOFF_FIELD_MAX } from './constants';
import type { Handoff, HandoffTest } from './types';

/**
 * The prompt sent into the (current) worker session to produce a structured
 * handoff. Spec 24: explicitly forbids code changes / continuation /
 * explanation — ONLY handoff JSON. Spec 51: the resulting response is treated
 * as a special internal operation, NOT task work; the session is discarded.
 */
export function buildHandoffPrompt(objective: string): string {
  return [
    'You are generating an AUTONOMOUS SESSION HANDOFF for a fresh session that will replace this one.',
    '',
    'STRICT RULES:',
    '- NO CODE CHANGES.',
    '- NO TASK CONTINUATION.',
    '- NO GENERAL EXPLANATION.',
    '- ONLY HANDOFF JSON.',
    '',
    'Inspect the actual repository state to ground every field. Do not trust prior conversation claims.',
    '',
    'Respond with a SINGLE JSON object (no prose, no markdown fences) with EXACTLY these fields:',
    '{',
    '  "currentState": string,           // what is true right now about the work',
    '  "completedWork": string[],        // specific completed implementation items',
    '  "remainingWork": string[],         // things still needing to be done',
    '  "filesChanged": string[],         // relevant file paths created/modified/deleted',
    '  "tests": [ {"command": string, "result": "PASS|FAIL|UNKNOWN", "details": string?} ],',
    '  "failures": string[],             // known failures, errors, regressions, blockers',
    '  "decisions": string[],            // important architectural/implementation decisions made',
    '  "constraints": string[],          // requirements that must not be changed',
    '  "nextAction": string              // the single most important next action for the fresh session',
    '}',
    '',
    'ORIGINAL OBJECTIVE (immutable, for grounding only — do NOT change it):',
    objective,
  ].join('\n');
}

/** Spec 25: objective must always equal the immutable run objective. */
export function stampObjective(handoff: Handoff, objective: string): Handoff {
  return { ...handoff, objective };
}

/** Spec 26: validate before accepting. Returns list of field errors (empty = valid). */
export function validateHandoff(handoff: unknown): string[] {
  const errors: string[] = [];
  if (!handoff || typeof handoff !== 'object') {
    return ['handoff is not an object'];
  }
  const h = handoff as Record<string, unknown>;

  const needStr = (k: string, max: number) => {
    const v = h[k];
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`${k} must be a non-empty string`);
      return;
    }
    if (v.length > max) errors.push(`${k} exceeds ${max} chars`);
  };
  const needStrArr = (k: string, maxItems: number, itemMax: number) => {
    const v = h[k];
    if (!Array.isArray(v)) {
      errors.push(`${k} must be an array`);
      return;
    }
    if (v.length > maxItems) errors.push(`${k} has too many items (>${maxItems})`);
    for (const it of v) {
      if (typeof it !== 'string') {
        errors.push(`${k} contains a non-string item`);
        break;
      }
      if (it.length > itemMax) {
        errors.push(`${k} has an item exceeding ${itemMax} chars`);
        break;
      }
    }
  };

  needStr('currentState', HANDOFF_FIELD_MAX.currentState);
  needStrArr('completedWork', HANDOFF_FIELD_MAX.listItems, HANDOFF_FIELD_MAX.item);
  needStrArr('remainingWork', HANDOFF_FIELD_MAX.listItems, HANDOFF_FIELD_MAX.item);
  needStrArr('filesChanged', HANDOFF_FIELD_MAX.listItems, HANDOFF_FIELD_MAX.item);
  needStrArr('failures', HANDOFF_FIELD_MAX.listItems, HANDOFF_FIELD_MAX.item);
  needStrArr('decisions', HANDOFF_FIELD_MAX.listItems, HANDOFF_FIELD_MAX.item);
  needStrArr('constraints', HANDOFF_FIELD_MAX.listItems, HANDOFF_FIELD_MAX.item);
  needStr('nextAction', HANDOFF_FIELD_MAX.nextAction);

  // tests array
  const t = h.tests;
  if (!Array.isArray(t)) {
    errors.push('tests must be an array');
  } else if (t.length > HANDOFF_FIELD_MAX.tests) {
    errors.push(`tests has too many items (>${HANDOFF_FIELD_MAX.tests})`);
  } else {
    t.forEach((item, i) => {
      if (!item || typeof item !== 'object') {
        errors.push(`tests[${i}] is not an object`);
        return;
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj.result !== 'string' || !['PASS', 'FAIL', 'UNKNOWN'].includes(obj.result)) {
        errors.push(`tests[${i}].result must be PASS|FAIL|UNKNOWN`);
      }
      if (obj.command !== undefined && typeof obj.command !== 'string') {
        errors.push(`tests[${i}].command must be a string`);
      }
      if (obj.details !== undefined && typeof obj.details !== 'string') {
        errors.push(`tests[${i}].details must be a string`);
      }
    });
  }

  return errors;
}

export function isValidHandoff(handoff: unknown): handoff is Handoff {
  return validateHandoff(handoff).length === 0;
}

/** Parse an LLM response that may contain JSON, possibly wrapped in fences. */
export function parseHandoffResponse(raw: string): Handoff | null {
  if (!raw) return null;
  let text = raw.trim();
  // strip markdown fences if present
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // find the outermost JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!isValidHandoff(parsed)) return null;
    return parsed as Handoff;
  } catch {
    return null;
  }
}

/** Normalize a possibly-partial handoff into a full Handoff object (used in fallback only). */
export function normalizeHandoff(partial: Partial<Handoff>, objective: string): Handoff {
  return {
    objective,
    currentState: partial.currentState ?? '',
    completedWork: partial.completedWork ?? [],
    remainingWork: partial.remainingWork ?? [],
    filesChanged: partial.filesChanged ?? [],
    tests: partial.tests ?? [],
    failures: partial.failures ?? [],
    decisions: partial.decisions ?? [],
    constraints: partial.constraints ?? [],
    nextAction: partial.nextAction ?? '',
    generatedAt: new Date().toISOString(),
  };
}

/** Compact text serialization for prompt embedding (spec 6). */
export function serializeHandoff(h: Handoff): string {
  const tests = h.tests.map((t: HandoffTest) => {
    const cmd = t.command ? `${t.command}` : '(no command)';
    return `- ${cmd}: ${t.result}${t.details ? ` — ${t.details}` : ''}`;
  });
  return [
    'AUTONOMOUS SESSION HANDOFF',
    '',
    'ORIGINAL OBJECTIVE',
    h.objective,
    '',
    'CURRENT STATE',
    h.currentState,
    '',
    'COMPLETED WORK',
    ...(h.completedWork.length ? h.completedWork.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'REMAINING WORK',
    ...(h.remainingWork.length ? h.remainingWork.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'FILES CHANGED',
    ...(h.filesChanged.length ? h.filesChanged.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'TESTS',
    ...(tests.length ? tests : ['- (none)']),
    '',
    'FAILURES',
    ...(h.failures.length ? h.failures.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'DECISIONS',
    ...(h.decisions.length ? h.decisions.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'CONSTRAINTS',
    ...(h.constraints.length ? h.constraints.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'EXACT NEXT ACTION',
    h.nextAction,
    '',
    'AUTONOMOUS PHASE',
    'WORK',
  ].join('\n');
}
