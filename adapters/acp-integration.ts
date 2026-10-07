// adapters/acp-integration.ts
//
// Reference implementation of the two ACP-backed strategies the controller
// needs: generateHandoffResponse (send a prompt into the current worker and
// read the structured-JSON response) and sendPrompt (call ACP session/prompt
// on a fresh session).
//
// This file calls into Goose Desktop's real ACP client functions
// (acpNewSession / acpPromptSession) — it does NOT reimplement ACP.
//
// Spec sections 23, 27, 29, 39, 51, 52, 53.
//
// Usage (renderer side, after install.sh has copied src/autonomous/ + the
// patches have wired useChatSession.ts):
//
//   import { AutonomousSessionController } from './autonomous';
//   import { electronStateStore } from '../adapters/electron-state-store';
//   import { electronLogger } from '../adapters/electron-logger';
//   import { acpHandoffGenerator, acpSendPrompt } from '../adapters/acp-integration';
//
//   export const autonomousController = new AutonomousSessionController({
//     store: electronStateStore,
//     logger: electronLogger,
//     generateHandoffResponse: acpHandoffGenerator,
//     sendPrompt: acpSendPrompt,
//   });
import { acpNewSession } from '../acp/sessions';
import { acpPromptSession } from '../acp/prompt';

/**
 * Spec 23: ask the current worker session to produce a structured handoff.
 *
 * The response is treated as a SPECIAL INTERNAL OPERATION (spec 51): its
 * output is NOT task work — only a handoff artifact. The session is then
 * abandoned anyway when the fresh worker takes over.
 */
export async function acpHandoffGenerator(input: {
  sessionId: string;
  objective: string;
  prompt: string;
}): Promise<string | null> {
  // acpPromptSession streams the model response. We collect the full text.
  // Goose's ACP client returns an async iterator of message chunks.
  let fullText = '';
  const stream = await acpPromptSession({
    sessionId: input.sessionId,
    prompt: input.prompt,
  });
  for await (const chunk of stream) {
    // Goose's message chunk shape: { type: 'assistant', content: string, ... }
    if (chunk?.type === 'assistant' && typeof chunk.content === 'string') {
      fullText += chunk.content;
    } else if (typeof chunk?.text === 'string') {
      fullText += chunk.text;
    }
  }
  return fullText || null;
}

/**
 * Spec 29: submit the continuation/verification prompt into a fresh session.
 *
 * The session was already created by the controller via sessionManager, which
 * called acpNewSession internally. This function only sends the prompt.
 */
export async function acpSendPrompt(input: {
  sessionId: string;
  prompt: string;
  origin: 'continuation' | 'verification';
}): Promise<void> {
  const stream = await acpPromptSession({
    sessionId: input.sessionId,
    prompt: input.prompt,
  });
  // Drain the stream so the session is primed and ready for the Desktop UI.
  // We don't need the content here — the controller's onTurnFinished hook
  // (wired by patch 0003) will collect the assistant's response when the
  // turn finishes.
  for await (const _chunk of stream) {
    // drain
  }
}

/**
 * Spec 27: create a completely fresh ACP session.
 *
 * Used by sessionManager.ts as the session-creation primitive. NEVER supplies
 * the previous session id as a history source (spec 27).
 */
export async function acpCreateFreshSession(workingDirectory: string): Promise<string> {
  const session = await acpNewSession({
    workingDirectory,
    // explicitly do NOT pass a `parentSessionId` or `history` field
  });
  return session.id;
}
