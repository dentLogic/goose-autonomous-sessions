// adapters/electron-logger.ts
//
// LoggerAdapter backed by the Electron main-process JSONL log.
// Delegates to appendElectronLog (batched, rotated) in electron-state-store.ts.
import type { LoggerAdapter } from '../src/autonomous/types';
import { appendElectronLog } from './electron-state-store';

export const electronLogger: LoggerAdapter = {
  info: (msg, runId) => appendElectronLog('info', msg, runId),
  warn: (msg, runId) => appendElectronLog('warn', msg, runId),
  error: (msg, runId) => appendElectronLog('error', msg, runId),
};
