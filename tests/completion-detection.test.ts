// tests/completion-detection.test.ts
// Spec sections 8, 9, 20, 21, 55, 56, 57, 73 — exact-line marker matching.
import { describe, it, expect } from 'bun:test';
import {
  detectVerificationStatus,
  detectWorkerStatus,
  workerCompleteOverrideRollover,
} from '../src/autonomous/completionDetector';

describe('worker status detection (exact-line match)', () => {
  it('detects AUTONOMOUS_STATUS: COMPLETE', () => {
    expect(detectWorkerStatus('all done\n\nAUTONOMOUS_STATUS: COMPLETE')).toBe('complete');
  });

  it('detects AUTONOMOUS_STATUS: CONTINUE', () => {
    expect(detectWorkerStatus('more to do\n\nAUTONOMOUS_STATUS: CONTINUE')).toBe('continue');
  });

  it('returns unknown for natural-language "complete"', () => {
    expect(detectWorkerStatus('I think we\'re complete.')).toBe('unknown');
    expect(detectWorkerStatus('The task is complete.')).toBe('unknown');
    expect(detectWorkerStatus('Done.')).toBe('unknown');
  });

  it('returns unknown for malformed markers', () => {
    expect(detectWorkerStatus('AUTONOMOUS_STATUS: MAYBE')).toBe('unknown');
    expect(detectWorkerStatus('AUTONOMOUS_STATUS: COMPLETELY')).toBe('unknown');
    expect(detectWorkerStatus('AUTONOMOUS_STATUS:COMPLETE')).toBe('complete'); // \s* allows zero spaces — this IS a match by design
  });

  it('returns unknown for empty input', () => {
    expect(detectWorkerStatus('')).toBe('unknown');
    expect(detectWorkerStatus(null as any)).toBe('unknown');
  });
});

describe('verification status detection', () => {
  it('detects AUTONOMOUS_VERIFICATION: PASS', () => {
    expect(detectVerificationStatus('verified\n\nAUTONOMOUS_VERIFICATION: PASS')).toBe('pass');
  });

  it('detects AUTONOMOUS_VERIFICATION: FAIL', () => {
    expect(detectVerificationStatus('incomplete\n\nAUTONOMOUS_VERIFICATION: FAIL')).toBe('fail');
  });

  it('returns unknown for natural language', () => {
    expect(detectVerificationStatus('looks good to me')).toBe('unknown');
    expect(detectVerificationStatus('verification failed')).toBe('unknown');
  });

  it('returns unknown for empty input', () => {
    expect(detectVerificationStatus('')).toBe('unknown');
  });
});

describe('workerCompleteOverrideRollover', () => {
  it('true when worker says COMPLETE (rollover must NOT happen)', () => {
    expect(workerCompleteOverrideRollover('AUTONOMOUS_STATUS: COMPLETE')).toBe(true);
  });

  it('false when worker says CONTINUE (rollover may proceed)', () => {
    expect(workerCompleteOverrideRollover('AUTONOMOUS_STATUS: CONTINUE')).toBe(false);
  });
});
