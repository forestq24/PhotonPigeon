/**
 * EXPERIMENT: a language model as the player. For the turn-based board games only.
 *
 * The model chooses; it does not referee. Each request shows it the position in words and asks
 * for one move. The answer is accepted only if it is one of the legal moves the game module
 * listed, and the game module still applies the move, detects the end of the game and builds
 * the card. If the model is slow, unreachable or answers with something illegal twice, the
 * search engine plays that move instead, so a game never stalls on the model.
 *
 * What leaves this machine: the board, the rules summary and the list of legal moves.
 * No phone numbers, player ids or message text.
 */
import type { Picked, Picker, PickRequest } from "../games/common/card.ts";

export interface ModelAnswer {
  move: string;
  /** The model's own short account of why. Logged, never sent to the opponent. */
  thinking: string;
}
/** Asks the model one question. `legal` is offered as the only allowed answers when it is short enough to list. */
export type Ask = (question: { system: string; prompt: string; legal?: string[] }) => Promise<ModelAnswer>;

/** Lists of legal moves longer than this are described by their format instead of spelled out. */
const LIST_UP_TO = 64;
const clean = (label: string): string => label.trim().toLowerCase().replace(/\s+/g, "");

/** What the model needs to see. The search engine's rules object is not part of it. */
export type ModelRequest<M> = Pick<PickRequest<unknown, M>, "legal" | "label" | "brief">;

/** One move from the model, or why there is none. Never throws. */
export async function askForMove<M>(ask: Ask, request: ModelRequest<M>, name: string): Promise<Picked<M> | { failed: string }> {
  const byLabel = new Map(request.legal.map((move) => [clean(request.label(move)), move] as const));
  if (byLabel.size !== request.legal.length) return { failed: "move labels are not unique" };
  // Nothing to decide: do not spend a model call on a forced move.
  if (request.legal.length === 1) return { move: request.legal[0]!, note: "only legal move" };
  const labels = request.legal.map(request.label);
  const listed = labels.length <= LIST_UP_TO ? labels : undefined;
  const { brief } = request;
  const system =
    `You are playing ${brief.game} against a person, as a real opponent would: you want to win. ` +
    "You are given the rules, the current position and how to write a move. Choose exactly one legal move. " +
    "Before choosing, check what the opponent threatens and what your move would allow them next.";
  const prompt =
    `Rules: ${brief.rules}\n\nPosition (it is your move):\n${brief.board}\n\n` +
    `Write your move as ${brief.moveFormat}.\n` +
    (listed ? `Legal moves: ${listed.join(", ")}` : `There are ${labels.length} legal moves.`);
  let complaint = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await ask({ system, prompt: prompt + complaint, legal: listed });
      const move = byLabel.get(clean(answer.move));
      if (move !== undefined) return { move, note: `${name}: ${answer.thinking.replace(/\s+/g, " ").slice(0, 300)}` };
      complaint = `\n\nYour previous answer "${answer.move.slice(0, 40)}" is not a legal move here. Choose a legal one.`;
    }
    return { failed: `${name} answered with illegal moves twice` };
  } catch (err) {
    return { failed: `${name} unavailable (${err instanceof Error ? err.message : "error"})` };
  }
}

/** A player for the shared board-game handler: the model chooses, and `fallback` plays when it cannot. */
export function modelPicker(ask: Ask, fallback: Picker, name: string): Picker {
  return async <S, M>(request: PickRequest<S, M>): Promise<Picked<M>> => {
    const picked = await askForMove(ask, request, name);
    if ("move" in picked) return picked;
    const backup = await fallback(request);
    return { move: backup.move, note: `${picked.failed}; engine played instead (${backup.note})` };
  };
}

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  workspaceId?: string;
  /** Tests only: a local stand-in for the API. */
  endpoint?: string;
}

/** One Messages API call that must answer through a tool, so the move comes back as data, not prose. */
export function anthropicAsk(options: AnthropicOptions): Ask {
  return async ({ system, prompt, legal }) => {
    const response = await fetch(options.endpoint ?? "https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
        ...(options.workspaceId ? { "anthropic-workspace-id": options.workspaceId } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: prompt }],
        tools: [{
          name: "play_move",
          description: "Play your move in the game.",
          input_schema: {
            type: "object",
            properties: {
              // Asked for first, so the reasoning comes before the commitment.
              thinking: { type: "string", description: "Two or three sentences: the threats on the board and why this move." },
              move: { type: "string", description: "The move, written exactly in the requested format.", ...(legal ? { enum: legal } : {}) },
            },
            required: ["thinking", "move"],
          },
        }],
        tool_choice: { type: "tool", name: "play_move" },
      }),
    });
    // Error bodies are not read: they are not needed and may echo the request.
    if (!response.ok) throw new Error(`model API returned ${response.status}`);
    const body = (await response.json()) as { content?: { type?: string; name?: string; input?: { move?: unknown; thinking?: unknown } }[] };
    const input = body.content?.find((block) => block.type === "tool_use" && block.name === "play_move")?.input;
    if (typeof input?.move !== "string") throw new Error("model did not return a move");
    return { move: input.move, thinking: typeof input.thinking === "string" ? input.thinking : "" };
  };
}
