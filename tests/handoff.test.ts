// tests/handoff.test.ts
// Spec sections 24, 26, 72 — handoff generation + validation.
import { describe, it, expect } from 'bun:test';
import {
  buildHandoffPrompt,
  isValidHandoff,
  parseHandoffResponse,
  validateHandoff,
  serializeHandoff,
  stampObjective,
} from '../src/autonomous/handoff';
import type { Handoff } from '../src/autonomous/types';

function validHandoff(): Handoff {
  return {
    objective: 'do the thing',
    currentState: 'half done',
    completedWork: ['item A'],
    remainingWork: ['item B'],
    filesChanged: ['src/foo.ts'],
    tests: [{ command: 'npm test', result: 'PASS' }],
    failures: [],
    decisions: ['decided X'],
    constraints: ['must be fast'],
    nextAction: 'do item B next',
    generatedAt: '2025-01-15T00:00:00.000Z',
  };
}

describe('handoff prompt builder', () => {
  it('forbids code changes and continuation', () => {
    const prompt = buildHandoffPrompt('the objective');
    expect(prompt).toContain('NO CODE CHANGES');
    expect(prompt).toContain('NO TASK CONTINUATION');
    expect(prompt).toContain('ONLY HANDOFF JSON');
    expect(prompt).toContain('the objective');
  });
});

describe('handoff validation', () => {
  it('accepts a valid handoff', () => {
    expect(validateHandoff(validHandoff())).toEqual([]);
    expect(isValidHandoff(validHandoff())).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateHandoff(null).length).toBeGreaterThan(0);
    expect(validateHandoff('string').length).toBeGreaterThan(0);
    expect(validateHandoff(undefined).length).toBeGreaterThan(0);
  });

  it('rejects empty nextAction', () => {
    const h = validHandoff();
    h.nextAction = '';
    expect(validateHandoff(h).length).toBeGreaterThan(0);
    expect(isValidHandoff(h)).toBe(false);
  });

  it('rejects empty currentState', () => {
    const h = validHandoff();
    h.currentState = '   ';
    expect(validateHandoff(h).length).toBeGreaterThan(0);
  });

  it('rejects non-array fields', () => {
    const h = validHandoff() as any;
    h.completedWork = 'not an array';
    expect(validateHandoff(h).length).toBeGreaterThan(0);
  });

  it('rejects invalid test result', () => {
    const h = validHandoff();
    h.tests = [{ command: 'npm test', result: 'MAYBE' }];
    expect(validateHandoff(h).length).toBeGreaterThan(0);
  });

  it('rejects oversize fields', () => {
    const h = validHandoff();
    h.currentState = 'x'.repeat(5000); // exceeds 4000
    expect(validateHandoff(h).length).toBeGreaterThan(0);
  });
});

describe('parseHandoffResponse', () => {
  it('parses clean JSON', () => {
    const raw = JSON.stringify({
      currentState: 'mid',
      completedWork: ['a'],
      remainingWork: ['b'],
      filesChanged: ['f.ts'],
      tests: [],
      failures: [],
      decisions: [],
      constraints: [],
      nextAction: 'do b',
    });
    const h = parseHandoffResponse(raw);
    expect(h).not.toBeNull();
    expect(h!.nextAction).toBe('do b');
  });

  it('parses JSON wrapped in markdown fences', () => {
    const raw = '```json\n' + JSON.stringify({
      currentState: 'mid',
      completedWork: [],
      remainingWork: [],
      filesChanged: [],
      tests: [],
      failures: [],
      decisions: [],
      constraints: [],
      nextAction: 'do the thing',
    }) + '\n```';
    const h = parseHandoffResponse(raw);
    expect(h).not.toBeNull();
    expect(h!.nextAction).toBe('do the thing');
  });

  it('parses JSON embedded in prose', () => {
    const raw = 'Here is the handoff:\n' + JSON.stringify({
      currentState: 'mid',
      completedWork: [],
      remainingWork: [],
      filesChanged: [],
      tests: [],
      failures: [],
      decisions: [],
      constraints: [],
      nextAction: 'do the thing',
    }) + '\nLet me know if you need more.';
    const h = parseHandoffResponse(raw);
    expect(h).not.toBeNull();
  });

  it('returns null for non-JSON', () => {
    expect(parseHandoffResponse('not json at all')).toBeNull();
    expect(parseHandoffResponse('')).toBeNull();
    expect(parseHandoffResponse(null as any)).toBeNull();
  });

  it('returns null for invalid handoff JSON', () => {
    expect(parseHandoffResponse('{"foo":"bar"}')).toBeNull();
  });
});

describe('stampObjective', () => {
  it('forces objective to the immutable run objective', () => {
    const h = validHandoff();
    h.objective = 'tampered';
    const stamped = stampObjective(h, 'the real objective');
    expect(stamped.objective).toBe('the real objective');
  });
});

describe('serializeHandoff', () => {
  it('produces the compact spec format', () => {
    const h = validHandoff();
    const text = serializeHandoff(h);
    expect(text).toContain('AUTONOMOUS SESSION HANDOFF');
    expect(text).toContain('ORIGINAL OBJECTIVE');
    expect(text).toContain('EXACT NEXT ACTION');
    expect(text).toContain('do item B next');
    expect(text).toContain('AUTONOMOUS PHASE');
    expect(text).toContain('WORK');
  });
});
