// tests/handoff-schema.test.ts
// v0.3 — configurable handoff schema.
import { describe, it, expect } from 'bun:test';
import {
  buildHandoffPromptFromSchema,
  coerceToHandoff,
  createHandoffSchema,
  defaultHandoffSchema,
  isValidHandoffAgainstSchema,
  parseHandoffResponseWithSchema,
  serializeHandoffWithSchema,
  validateHandoffAgainstSchema,
  type HandoffSchema,
} from '../src/autonomous/handoff-schema';
import { stampObjective } from '../src/autonomous/handoff';

function validHandoffObj(): Record<string, unknown> {
  return {
    currentState: 'half done',
    completedWork: ['item A'],
    remainingWork: ['item B'],
    filesChanged: ['src/foo.ts'],
    tests: [{ command: 'npm test', result: 'PASS' }],
    failures: [],
    decisions: ['decided X'],
    constraints: ['must be fast'],
    nextAction: 'do item B next',
  };
}

describe('default schema', () => {
  it('has 9 fields', () => {
    expect(defaultHandoffSchema().length).toBe(9);
  });

  it('includes all v0.1/v0.2 built-in fields', () => {
    const names = defaultHandoffSchema().map((f) => f.name);
    expect(names).toContain('currentState');
    expect(names).toContain('completedWork');
    expect(names).toContain('nextAction');
    expect(names).toContain('tests');
  });

  it('validates a handoff that the old validator would accept', () => {
    const errors = validateHandoffAgainstSchema(validHandoffObj(), defaultHandoffSchema());
    expect(errors).toEqual([]);
  });

  it('rejects missing required fields', () => {
    const h = validHandoffObj();
    delete h.nextAction;
    const errors = validateHandoffAgainstSchema(h, defaultHandoffSchema());
    expect(errors.some((e) => e.includes('nextAction'))).toBe(true);
  });
});

describe('createHandoffSchema — custom fields', () => {
  const customSchema: HandoffSchema = createHandoffSchema(defaultHandoffSchema(), [
    {
      name: 'securityReview',
      type: 'string',
      required: false,
      description: 'brief security note',
      maxLen: 500,
      label: 'SECURITY REVIEW',
    },
    {
      name: 'breakingChanges',
      type: 'string[]',
      required: true,
      description: 'breaking API/behavior changes',
      maxItems: 16,
      itemMax: 300,
      label: 'BREAKING CHANGES',
    },
  ]);

  it('has 11 fields (9 default + 2 custom)', () => {
    expect(customSchema.length).toBe(11);
  });

  it('accepts a handoff with the custom fields', () => {
    const h = {
      ...validHandoffObj(),
      securityReview: 'no threats found',
      breakingChanges: ['changed foo() signature'],
    };
    expect(validateHandoffAgainstSchema(h, customSchema)).toEqual([]);
  });

  it('rejects a handoff missing a required custom field', () => {
    const h = {
      ...validHandoffObj(),
      securityReview: 'ok',
      // breakingChanges missing (required)
    };
    const errors = validateHandoffAgainstSchema(h, customSchema);
    expect(errors.some((e) => e.includes('breakingChanges'))).toBe(true);
  });

  it('accepts a handoff with optional custom field omitted', () => {
    const h = {
      ...validHandoffObj(),
      breakingChanges: [],
      // securityReview is optional — may be omitted
    };
    expect(validateHandoffAgainstSchema(h, customSchema)).toEqual([]);
  });

  it('rejects wrong type for custom field', () => {
    const h = {
      ...validHandoffObj(),
      securityReview: 42, // should be string
      breakingChanges: [],
    };
    const errors = validateHandoffAgainstSchema(h, customSchema);
    expect(errors.some((e) => e.includes('securityReview'))).toBe(true);
  });

  it('rejects oversize custom string field', () => {
    const h = {
      ...validHandoffObj(),
      securityReview: 'x'.repeat(600), // exceeds 500
      breakingChanges: [],
    };
    const errors = validateHandoffAgainstSchema(h, customSchema);
    expect(errors.some((e) => e.includes('securityReview'))).toBe(true);
  });

  it('rejects non-array for custom string[] field', () => {
    const h = {
      ...validHandoffObj(),
      securityReview: 'ok',
      breakingChanges: 'not an array',
    };
    const errors = validateHandoffAgainstSchema(h, customSchema);
    expect(errors.some((e) => e.includes('breakingChanges'))).toBe(true);
  });

  it('custom field overrides built-in with same name', () => {
    const schema = createHandoffSchema(defaultHandoffSchema(), [
      {
        name: 'nextAction',
        type: 'string',
        required: true,
        description: 'custom description',
        maxLen: 100, // tighter than default 2000
      },
    ]);
    const field = schema.find((f) => f.name === 'nextAction')!;
    expect(field.maxLen).toBe(100);
    expect(field.description).toBe('custom description');
    // schema still has 9 fields (override, not append)
    expect(schema.length).toBe(9);
  });
});

describe('buildHandoffPromptFromSchema', () => {
  it('includes custom fields in the prompt', () => {
    const schema = createHandoffSchema(defaultHandoffSchema(), [
      {
        name: 'securityReview',
        type: 'string',
        required: false,
        description: 'brief security note',
      },
    ]);
    const prompt = buildHandoffPromptFromSchema('the objective', schema);
    expect(prompt).toContain('securityReview');
    expect(prompt).toContain('brief security note');
    expect(prompt).toContain('the objective');
    expect(prompt).toContain('ONLY HANDOFF JSON');
  });
});

describe('serializeHandoffWithSchema', () => {
  it('includes custom fields in the serialized output', () => {
    const schema = createHandoffSchema(defaultHandoffSchema(), [
      {
        name: 'securityReview',
        type: 'string',
        required: false,
        description: 'brief security note',
        label: 'SECURITY REVIEW',
      },
    ]);
    const h = {
      ...validHandoffObj(),
      objective: 'the objective',
      securityReview: 'no threats found',
    };
    const text = serializeHandoffWithSchema(h, schema);
    expect(text).toContain('SECURITY REVIEW');
    expect(text).toContain('no threats found');
    expect(text).toContain('AUTONOMOUS SESSION HANDOFF');
    expect(text).toContain('ORIGINAL OBJECTIVE');
  });

  it('shows (none) for omitted optional fields', () => {
    const schema = createHandoffSchema(defaultHandoffSchema(), [
      {
        name: 'securityReview',
        type: 'string',
        required: false,
        description: 'brief security note',
        label: 'SECURITY REVIEW',
      },
    ]);
    const h = { ...validHandoffObj(), objective: 'obj' };
    const text = serializeHandoffWithSchema(h, schema);
    expect(text).toContain('SECURITY REVIEW');
    expect(text).toContain('(none)');
  });
});

describe('parseHandoffResponseWithSchema', () => {
  const schema = createHandoffSchema(defaultHandoffSchema(), [
    {
      name: 'securityReview',
      type: 'string',
      required: false,
      description: 'brief security note',
    },
  ]);

  it('parses clean JSON with custom fields', () => {
    const raw = JSON.stringify({
      ...validHandoffObj(),
      securityReview: 'all clear',
    });
    const parsed = parseHandoffResponseWithSchema(raw, schema);
    expect(parsed).not.toBeNull();
    expect(parsed!.securityReview).toBe('all clear');
  });

  it('parses fenced JSON', () => {
    const raw = '```json\n' + JSON.stringify({ ...validHandoffObj(), securityReview: 'ok' }) + '\n```';
    const parsed = parseHandoffResponseWithSchema(raw, schema);
    expect(parsed).not.toBeNull();
  });

  it('returns null for invalid handoff', () => {
    expect(parseHandoffResponseWithSchema('{"foo":"bar"}', schema)).toBeNull();
    expect(parseHandoffResponseWithSchema('not json', schema)).toBeNull();
  });
});

describe('coerceToHandoff', () => {
  it('extracts built-in fields from a parsed object with custom fields', () => {
    const parsed = {
      ...validHandoffObj(),
      securityReview: 'custom field',
      someOtherCustom: 42,
    };
    const handoff = coerceToHandoff(parsed, 'the objective');
    expect(handoff.objective).toBe('the objective');
    expect(handoff.currentState).toBe('half done');
    expect(handoff.completedWork).toEqual(['item A']);
    expect(handoff.nextAction).toBe('do item B next');
  });

  it('handles missing fields gracefully', () => {
    const handoff = coerceToHandoff({}, 'obj');
    expect(handoff.objective).toBe('obj');
    expect(handoff.currentState).toBe('');
    expect(handoff.completedWork).toEqual([]);
  });

  it('stampObjective works on coerced handoff', () => {
    const handoff = coerceToHandoff(validHandoffObj(), 'obj');
    const stamped = stampObjective(handoff, 'the real objective');
    expect(stamped.objective).toBe('the real objective');
  });
});

describe('isValidHandoffAgainstSchema — type guard', () => {
  it('returns true for valid, false for invalid', () => {
    const schema = defaultHandoffSchema();
    expect(isValidHandoffAgainstSchema(validHandoffObj(), schema)).toBe(true);
    expect(isValidHandoffAgainstSchema({}, schema)).toBe(false);
    expect(isValidHandoffAgainstSchema(null, schema)).toBe(false);
    expect(isValidHandoffAgainstSchema('string', schema)).toBe(false);
  });
});
