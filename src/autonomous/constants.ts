// src/lib/autonomous/constants.ts

export const AUTONOMOUS_SCHEMA_VERSION = 1;

export const DEFAULT_ROLLOVER_THRESHOLD = 0.75;
export const DEFAULT_CONTEXT_LIMIT = 200_000; // tokens (informational)
export const MAX_LOG_ROWS = 500;

// Completion / verification markers — exact line matches only.
export const MARKER_WORKER_COMPLETE = 'AUTONOMOUS_STATUS: COMPLETE';
export const MARKER_WORKER_CONTINUE = 'AUTONOMOUS_STATUS: CONTINUE';
export const MARKER_VERIFY_PASS = 'AUTONOMOUS_VERIFICATION: PASS';
export const MARKER_VERIFY_FAIL = 'AUTONOMOUS_VERIFICATION: FAIL';

export const REGEX_WORKER_COMPLETE = /^AUTONOMOUS_STATUS:\s*COMPLETE\s*$/m;
export const REGEX_WORKER_CONTINUE = /^AUTONOMOUS_STATUS:\s*CONTINUE\s*$/m;
export const REGEX_VERIFY_PASS = /^AUTONOMOUS_VERIFICATION:\s*PASS\s*$/m;
export const REGEX_VERIFY_FAIL = /^AUTONOMOUS_VERIFICATION:\s*FAIL\s*$/m;

// IPC channel names (renderer <-> main). Kept here so renderer & main agree.
export const IPC = {
  GET_STATE: 'autonomous:get-state',
  SET_STATE: 'autonomous:set-state',
  CLEAR_STATE: 'autonomous:clear-state',
  GET_SETTINGS: 'autonomous:get-settings',
  SET_SETTINGS: 'autonomous:set-settings',
} as const;

// Desktop navigation event for auto-switching sessions.
export const NAV_EVENT_SWITCH_SESSION = 'GOOSE_AUTONOMOUS_SWITCH_SESSION';

export const HANDOFF_FIELD_MAX = {
  currentState: 4000,
  nextAction: 2000,
  item: 1000,
  tests: 64,
  listItems: 128,
} as const;

export const DEFAULT_SETTINGS = {
  enabled: false,
  rolloverThreshold: DEFAULT_ROLLOVER_THRESHOLD,
} as const;
