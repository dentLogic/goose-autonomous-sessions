// src/autonomous/handoff-schema.ts
//
// Configurable handoff schema (v0.3).
//
// The built-in handoff has 10 fixed fields (currentState, completedWork, …).
// This module lets a host extend the schema with custom fields — e.g. a
// "securityReview" string, a "breakingChanges" string[], or a
// "performanceBenchmarks" test[] — without forking the controller.
//
// The schema drives three things:
//   1. The handoff-generation prompt (tells the LLM exactly what fields to produce)
//   2. Validation (enforces required fields + type/length constraints)
//   3. Serialization (renders the compact text format for prompt embedding)
//
// Backward compatible: if no schema is supplied, the controller uses
// defaultHandoffSchema() which reproduces the original v0.1/v0.2 behavior.
import { HANDOFF_FIELD_MAX } from './constants';
import type { Handoff, HandoffTest } from './types';

// ─── field types ─────────────────────────────────────────────────────────────

export type HandoffFieldType = 'string' | 'string[]' | 'test[]';

export interface HandoffField {
  /** Field name as it appears in the JSON object (e.g. "securityReview"). */
  name: string;
  type: HandoffFieldType;
  required: boolean;
  /** Human description used in the prompt so the LLM knows what to put here. */
  description: string;
  /** Max chars for 'string'; max items for arrays. */
  maxLen?: number;
  maxItems?: number;
  /** Max chars per array item (for 'string[]' and 'test[].details'). */
  itemMax?: number;
  /** Label used in the compact text serialization (defaults to uppercased name). */
  label?: string;
}

export type HandoffSchema = HandoffField[];

// ─── default schema (reproduces v0.1/v0.2 behavior) ──────────────────────────

export function defaultHandoffSchema(): HandoffSchema {
  return [
    {
      name: 'currentState',
      type: 'string',
      required: true,
      description: 'what is true right now about the work',
      maxLen: HANDOFF_FIELD_MAX.currentState,
      label: 'CURRENT STATE',
    },
    {
      name: 'completedWork',
      type: 'string[]',
      required: true,
      description: 'specific completed implementation items',
      maxItems: HANDOFF_FIELD_MAX.listItems,
      itemMax: HANDOFF_FIELD_MAX.item,
      label: 'COMPLETED WORK',
    },
    {
      name: 'remainingWork',
      type: 'string[]',
      required: true,
      description: 'things still needing to be done',
      maxItems: HANDOFF_FIELD_MAX.listItems,
      itemMax: HANDOFF_FIELD_MAX.item,
      label: 'REMAINING WORK',
    },
    {
      name: 'filesChanged',
      type: 'string[]',
      required: true,
      description: 'relevant file paths created/modified/deleted',
      maxItems: HANDOFF_FIELD_MAX.listItems,
      itemMax: HANDOFF_FIELD_MAX.item,
      label: 'FILES CHANGED',
    },
    {
      name: 'tests',
      type: 'test[]',
      required: true,
      description: 'tests run and their results',
      maxItems: HANDOFF_FIELD_MAX.tests,
      label: 'TESTS',
    },
    {
      name: 'failures',
      type: 'string[]',
      required: true,
      description: 'known failures, errors, regressions, blockers',
      maxItems: HANDOFF_FIELD_MAX.listItems,
      itemMax: HANDOFF_FIELD_MAX.item,
      label: 'FAILURES',
    },
    {
      name: 'decisions',
      type: 'string[]',
      required: true,
      description: 'important architectural/implementation decisions made',
      maxItems: HANDOFF_FIELD_MAX.listItems,
      itemMax: HANDOFF_FIELD_MAX.item,
      label: 'DECISIONS',
    },
    {
      name: 'constraints',
      type: 'string[]',
      required: true,
      description: 'requirements that must not be changed',
      maxItems: HANDOFF_FIELD_MAX.listItems,
      itemMax: HANDOFF_FIELD_MAX.item,
      label: 'CONSTRAINTS',
    },
    {
      name: 'nextAction',
      type: 'string',
      required: true,
      description: 'the single most important next action for the fresh session',
      maxLen: HANDOFF_FIELD_MAX.nextAction,
      label: 'EXACT NEXT ACTION',
    },
  ];
}

// ─── schema composition ──────────────────────────────────────────────────────

/**
 * Extend the default schema with custom fields. Returns a NEW schema (does not
 * mutate the base). If a custom field has the same name as a built-in field,
 * the custom field REPLACES the built-in (useful for tightening constraints).
 *
 * @example
 * const schema = createHandoffSchema(
 *   defaultHandoffSchema(),
 *   [
 *     {
 *       name: 'securityReview',
 *       type: 'string',
 *       required: false,
 *       description: 'brief security review note (threats, mitigations)',
 *       maxLen: 1000,
 *       label: 'SECURITY REVIEW',
 *     },
 *     {
 *       name: 'breakingChanges',
 *       type: 'string[]',
 *       required: true,
 *       description: 'list of breaking API/behavior changes',
 *       maxItems: 32,
 *       itemMax: 500,
 *       label: 'BREAKING CHANGES',
 *     },
 *   ]
 * );
 */
export function createHandoffSchema(
  base: HandoffSchema,
  extensions: HandoffField[]
): HandoffSchema {
  const map = new Map<string, HandoffField>();
  for (const f of base) map.set(f.name, f);
  for (const f of extensions) map.set(f.name, f); // extensions override
  return Array.from(map.values());
}

// ─── schema-aware prompt builder ─────────────────────────────────────────────

export function buildHandoffPromptFromSchema(
  objective: string,
  schema: HandoffSchema
): string {
  const fieldLines = schema.map((f) => {
    const typeStr =
      f.type === 'string'
        ? 'string'
        : f.type === 'string[]'
          ? 'string[]'
          : '[ {"command": string, "result": "PASS|FAIL|UNKNOWN", "details": string?} ]';
    const req = f.required ? ' (required)' : ' (optional)';
    return `  "${f.name}": ${typeStr},  // ${f.description}${req}`;
  });
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
    ...fieldLines,
    '}',
    '',
    'ORIGINAL OBJECTIVE (immutable, for grounding only — do NOT change it):',
    objective,
  ].join('\n');
}

// ─── schema-aware validation ─────────────────────────────────────────────────

/**
 * Validate a handoff against a schema. Returns a list of error strings
 * (empty = valid). Handles 'string', 'string[]', and 'test[]' field types.
 */
export function validateHandoffAgainstSchema(
  handoff: unknown,
  schema: HandoffSchema
): string[] {
  const errors: string[] = [];
  if (!handoff || typeof handoff !== 'object') {
    return ['handoff is not an object'];
  }
  const h = handoff as Record<string, unknown>;

  for (const field of schema) {
    const v = h[field.name];
    if (v === undefined || v === null) {
      if (field.required) errors.push(`${field.name} is required`);
      continue;
    }

    if (field.type === 'string') {
      if (typeof v !== 'string') {
        errors.push(`${field.name} must be a string`);
        continue;
      }
      if (field.required && v.trim() === '') {
        errors.push(`${field.name} must be non-empty`);
      }
      if (field.maxLen && v.length > field.maxLen) {
        errors.push(`${field.name} exceeds ${field.maxLen} chars`);
      }
    } else if (field.type === 'string[]') {
      if (!Array.isArray(v)) {
        errors.push(`${field.name} must be an array`);
        continue;
      }
      const maxItems = field.maxItems ?? HANDOFF_FIELD_MAX.listItems;
      if (v.length > maxItems) {
        errors.push(`${field.name} has too many items (>${maxItems})`);
      }
      for (const it of v) {
        if (typeof it !== 'string') {
          errors.push(`${field.name} contains a non-string item`);
          break;
        }
        if (field.itemMax && it.length > field.itemMax) {
          errors.push(`${field.name} has an item exceeding ${field.itemMax} chars`);
          break;
        }
      }
    } else if (field.type === 'test[]') {
      if (!Array.isArray(v)) {
        errors.push(`${field.name} must be an array`);
        continue;
      }
      const maxItems = field.maxItems ?? HANDOFF_FIELD_MAX.tests;
      if (v.length > maxItems) {
        errors.push(`${field.name} has too many items (>${maxItems})`);
      }
      v.forEach((item, i) => {
        if (!item || typeof item !== 'object') {
          errors.push(`${field.name}[${i}] is not an object`);
          return;
        }
        const obj = item as Record<string, unknown>;
        if (
          typeof obj.result !== 'string' ||
          !['PASS', 'FAIL', 'UNKNOWN'].includes(obj.result)
        ) {
          errors.push(`${field.name}[${i}].result must be PASS|FAIL|UNKNOWN`);
        }
        if (obj.command !== undefined && typeof obj.command !== 'string') {
          errors.push(`${field.name}[${i}].command must be a string`);
        }
        if (obj.details !== undefined && typeof obj.details !== 'string') {
          errors.push(`${field.name}[${i}].details must be a string`);
        }
      });
    }
  }

  return errors;
}

export function isValidHandoffAgainstSchema(
  handoff: unknown,
  schema: HandoffSchema
): handoff is Record<string, unknown> {
  return validateHandoffAgainstSchema(handoff, schema).length === 0;
}

// ─── schema-aware serialization ──────────────────────────────────────────────

/**
 * Serialize a handoff into the compact text format, including any custom
 * fields defined in the schema. Custom fields appear after the built-in ones
 * in schema order.
 */
export function serializeHandoffWithSchema(
  h: Record<string, unknown>,
  schema: HandoffSchema
): string {
  const sections: string[] = ['AUTONOMOUS SESSION HANDOFF', ''];

  // objective always first (it's not in the schema — it's stamped separately)
  sections.push('ORIGINAL OBJECTIVE');
  sections.push(String(h.objective ?? ''));
  sections.push('');

  for (const field of schema) {
    const label = field.label ?? field.name.toUpperCase();
    const v = h[field.name];

    if (field.type === 'string') {
      sections.push(label);
      sections.push(typeof v === 'string' && v ? v : '(none)');
      sections.push('');
    } else if (field.type === 'string[]') {
      sections.push(label);
      const arr = Array.isArray(v) ? (v as unknown[]) : [];
      if (arr.length === 0) {
        sections.push('- (none)');
      } else {
        for (const it of arr) sections.push(`- ${String(it)}`);
      }
      sections.push('');
    } else if (field.type === 'test[]') {
      sections.push(label);
      const arr = Array.isArray(v) ? (v as HandoffTest[]) : [];
      if (arr.length === 0) {
        sections.push('- (none)');
      } else {
        for (const t of arr) {
          const cmd = t.command ?? '(no command)';
          sections.push(`- ${cmd}: ${t.result}${t.details ? ` — ${t.details}` : ''}`);
        }
      }
      sections.push('');
    }
  }

  sections.push('AUTONOMOUS PHASE');
  sections.push('WORK');
  return sections.join('\n');
}

// ─── schema-aware parsing ────────────────────────────────────────────────────

/**
 * Parse an LLM response into a handoff object validated against the given
 * schema. Fence-tolerant. Returns null on parse/validation failure.
 */
export function parseHandoffResponseWithSchema(
  raw: string,
  schema: HandoffSchema
): Record<string, unknown> | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!isValidHandoffAgainstSchema(parsed, schema)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── coerce a parsed handoff to the Handoff interface ────────────────────────
//
// The controller's Handoff type has the 9 built-in fields (plus objective).
// When a custom schema is used, the parsed object may have extra fields. This
// helper coerces the built-in fields from the parsed object, preserving custom
// fields via the `custom` bag.
export function coerceToHandoff(
  parsed: Record<string, unknown>,
  objective: string
): Handoff {
  return {
    objective,
    currentState: String(parsed.currentState ?? ''),
    completedWork: Array.isArray(parsed.completedWork) ? (parsed.completedWork as string[]) : [],
    remainingWork: Array.isArray(parsed.remainingWork) ? (parsed.remainingWork as string[]) : [],
    filesChanged: Array.isArray(parsed.filesChanged) ? (parsed.filesChanged as string[]) : [],
    tests: Array.isArray(parsed.tests) ? (parsed.tests as HandoffTest[]) : [],
    failures: Array.isArray(parsed.failures) ? (parsed.failures as string[]) : [],
    decisions: Array.isArray(parsed.decisions) ? (parsed.decisions as string[]) : [],
    constraints: Array.isArray(parsed.constraints) ? (parsed.constraints as string[]) : [],
    nextAction: String(parsed.nextAction ?? ''),
    generatedAt: new Date().toISOString(),
  };
}
