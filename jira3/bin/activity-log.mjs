#!/usr/bin/env node
// Hook-driven agent-activity logger: one timestamped JSONL line per event,
// appended to <project>/jira/activity.jsonl. Runs out-of-band via hooks, so
// tracking costs the working session zero tokens. Logs only inside projects
// that have jira/config.json; never blocks or errors the hook chain.
//
// Events, and the pairing contract:
//   agent:dispatch    PostToolUse(Agent) — carries the agent_id, so it pairs
//                     with its agent:stop by id. Foreground dispatches
//                     (run_in_background: false) return the finished result in
//                     the same tool_response; total_tokens/duration_ms are
//                     logged when offered.
//   workflow:dispatch PostToolUse(Workflow) — one line per workflow run
//                     (run_id). The workflow's individual agents are NOT
//                     hook-visible at dispatch (no per-agent tool call); their
//                     agent:stop lines correlate to the run by session_id +
//                     time window, or exactly via the run's journal.jsonl.
//   agent:message     PostToolUse(SendMessage) — continuation of a live agent.
//   agent:stop        SubagentStop — every real subagent, any spawn path.
//                     Harness-internal utility subagents stop with an EMPTY
//                     agent_type and never have any dispatch; they are skipped
//                     so every logged stop belongs to a dispatch or a workflow.
import fs from 'node:fs';
import path from 'node:path';

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || '';
    if (!projectDir || !fs.existsSync(path.join(projectDir, 'jira', 'config.json'))) return;

    const line = buildLine(input);
    if (!line) return;
    fs.appendFileSync(
      path.join(projectDir, 'jira', 'activity.jsonl'),
      JSON.stringify(line) + '\n'
    );
  } catch {
    // Telemetry must never break the session's tool flow.
  }
});

// The Agent tool's response is a structured object with a top-level agentId
// (observed 2026-07-16; both background launch metadata and foreground
// results carry it). Read the field first; fall back to a quote-tolerant
// regex so a text/serialized response still yields the id. The original
// /agentId:\s*/ form matched NEITHER shape once stringified ("agentId":"…"
// puts a quote before the colon) — that is why historical dispatch lines
// carry agent_id: null.
function agentIdFrom(toolResponse) {
  if (
    toolResponse &&
    typeof toolResponse === 'object' &&
    typeof toolResponse.agentId === 'string'
  ) {
    return toolResponse.agentId;
  }
  const text =
    typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? '');
  return /"?agentId"?\s*:\s*"?([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
}

function buildLine(input) {
  const ts = new Date().toISOString();
  const base = { ts, session_id: input.session_id ?? null };

  if (input.hook_event_name === 'SubagentStop') {
    // Typeless stops are harness-internal helpers (output summarizers etc.) —
    // no dispatch ever exists for them; skip to keep the stream pairable.
    if (!input.agent_type) return null;
    return {
      ...base,
      event: 'agent:stop',
      agent_id: input.agent_id ?? null,
      agent_type: input.agent_type,
    };
  }

  if (input.hook_event_name !== 'PostToolUse') return null;
  const toolInput = input.tool_input ?? {};

  if (input.tool_name === 'Agent') {
    const prompt = String(toolInput.prompt ?? '');
    const tr = input.tool_response;
    return {
      ...base,
      event: 'agent:dispatch',
      agent_id: agentIdFrom(tr),
      agent_type: toolInput.subagent_type ?? 'general-purpose',
      model: toolInput.model ?? null,
      description: toolInput.description ?? null,
      prompt_chars: prompt.length,
      prompt_head: prompt.slice(0, 300),
      // Foreground dispatches complete inside the tool call — take the
      // totals when the response offers them (background launches don't).
      // ts is completion time for these (PostToolUse fires on return), so
      // also derive started_ts — consumers shouldn't re-derive it.
      ...(tr && typeof tr === 'object' && tr.totalTokens != null
        ? {
            total_tokens: tr.totalTokens,
            duration_ms: tr.totalDurationMs ?? null,
            ...(tr.totalDurationMs != null
              ? { started_ts: new Date(Date.parse(ts) - tr.totalDurationMs).toISOString() }
              : {}),
          }
        : {}),
    };
  }

  if (input.tool_name === 'Workflow') {
    const text =
      typeof input.tool_response === 'string'
        ? input.tool_response
        : JSON.stringify(input.tool_response ?? '');
    const script = String(toolInput.script ?? '');
    return {
      ...base,
      event: 'workflow:dispatch',
      run_id: /\b(wf_[a-z0-9-]{6,})\b/.exec(text)?.[1] ?? null,
      name:
        toolInput.name ?? (/\bname:\s*['"]([^'"]+)['"]/.exec(script)?.[1] ?? null),
      description: /Summary:\s*(.+)/.exec(text)?.[1]?.trim() ?? null,
      script_chars: script.length,
    };
  }

  if (input.tool_name === 'SendMessage') {
    return {
      ...base,
      event: 'agent:message',
      to: toolInput.to ?? null,
      summary: toolInput.summary ?? null,
    };
  }

  return null;
}
