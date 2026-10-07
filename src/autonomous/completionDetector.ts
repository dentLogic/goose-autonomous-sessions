// src/lib/autonomous/completionDetector.ts
// Spec sections 8, 9, 20, 21, 22, 55, 56, 57, 73.
import {
  REGEX_VERIFY_FAIL,
  REGEX_VERIFY_PASS,
  REGEX_WORKER_COMPLETE,
  REGEX_WORKER_CONTINUE,
} from './constants';
import type { VerificationStatus, WorkerStatus } from './types';

export function detectWorkerStatus(text: string): WorkerStatus {
  if (!text) return 'unknown';
  if (REGEX_WORKER_COMPLETE.test(text)) return 'complete';
  if (REGEX_WORKER_CONTINUE.test(text)) return 'continue';
  return 'unknown';
}

export function detectVerificationStatus(text: string): VerificationStatus {
  if (!text) return 'unknown';
  if (REGEX_VERIFY_PASS.test(text)) return 'pass';
  if (REGEX_VERIFY_FAIL.test(text)) return 'fail';
  return 'unknown';
}

// Worker completion takes precedence over an ordinary rollover (spec 22).
// If the worker emitted COMPLETE, we must NOT do a context rollover.
export function workerCompleteOverrideRollover(text: string): boolean {
  return detectWorkerStatus(text) === 'complete';
}
