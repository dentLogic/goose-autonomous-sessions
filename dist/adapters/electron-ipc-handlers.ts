// adapters/electron-ipc-handlers.ts
//
// Electron main-process IPC handlers that expose the autonomous state to the
// renderer. Registered in main.ts (patch 0005 calls registerAutonomousIpc()).
//
// The renderer never knows the filesystem path — it only sees the IPC channel
// names from src/autonomous/constants.ts.
//
// Spec sections 10, 11.
//
// NOTE: This file imports 'electron' which is only available in the Electron
// main process. It is NOT included in the npm package (see .npmignore).
// @ts-ignore — electron is a peer dependency provided by the host
import { ipcMain } from 'electron';
import {
  IPC,
} from '../src/autonomous/constants';
import {
  electronStateStore,
  getElectronLogs,
  clearAllElectronState,
  flushElectronLogs,
} from './electron-state-store';

export function registerAutonomousIpc(): void {
  ipcMain.handle(IPC.GET_STATE, async () => {
    return electronStateStore.getRun();
  });

  ipcMain.handle(IPC.SET_STATE, async (_event: unknown, run: any) => {
    await electronStateStore.saveRun(run);
    return { ok: true };
  });

  ipcMain.handle(IPC.CLEAR_STATE, async () => {
    await clearAllElectronState();
    return { ok: true };
  });

  ipcMain.handle(IPC.GET_SETTINGS, async () => {
    return electronStateStore.getSettings();
  });

  ipcMain.handle(IPC.SET_SETTINGS, async (_event: unknown, settings: any) => {
    await electronStateStore.saveSettings(settings);
    return { ok: true };
  });

  // Bonus: expose logs + sessions to the renderer (for the Desktop status UI).
  ipcMain.handle('autonomous:get-logs', async (_event: unknown, limit?: number, runId?: string) => {
    return getElectronLogs(limit ?? 200, runId);
  });

  ipcMain.handle('autonomous:get-sessions', async (_event: unknown, runId?: string) => {
    return electronStateStore.getSessions(runId);
  });
}

/** Call on app 'before-quit' to flush pending log entries. */
export async function onAppQuit(): Promise<void> {
  await flushElectronLogs();
}
