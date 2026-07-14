import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getClient } from "../lib/client.js";
import {
  AgentTurnController,
  type AgentTurnPolicy,
  type AgentTurnRequest,
  type ApprovalVerdict,
  type SendAgentTurn,
} from "../lib/agent-turn.js";
import type { UiMsg } from "../lib/agent-stream.js";
import type { Usage } from "@ew/shared";

const daemonTransport = {
  run(request: AgentTurnRequest, signal: AbortSignal) {
    return getClient().runAgent(request, { signal });
  },
  approve(id: string, verdict: ApprovalVerdict) {
    return getClient().approveTool(id, verdict);
  },
};

/** Thin React adapter; lifecycle semantics live in AgentTurnController. */
export function useAgentTurn(policy: AgentTurnPolicy) {
  const controllerRef = useRef<AgentTurnController | null>(null);
  if (!controllerRef.current) controllerRef.current = new AgentTurnController(daemonTransport, policy);
  const controller = controllerRef.current;
  useLayoutEffect(() => controller.setPolicy(policy), [controller, policy]);

  const state = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getState(),
    () => controller.getState(),
  );

  useEffect(() => () => controller.dispose(), [controller]);

  return {
    ...state,
    send: (input: SendAgentTurn) => controller.send(input),
    retry: () => controller.retry(),
    editRetry: (text: string) => controller.editRetry(text),
    stop: () => controller.stop(),
    respondApproval: (verdict: ApprovalVerdict) => controller.respondApproval(verdict),
    restore: (messages: UiMsg[], usage: Usage | null = null) => controller.restore(messages, usage),
    setUsage: (usage: Usage | null) => controller.setUsage(usage),
  };
}
