/** Pure conversation policy; no gameplay actions, network, wall clock, or random source. */
export const PERSONA_VERSION = 'pigeon-haiku-v2';
export const MODEL = 'claude-haiku-4-5-20251001';
export const COOLDOWN_MICROS = 60_000_000n;
export type Outcome = 'human_win' | 'human_loss' | 'draw';
export const VOICE = 'You are Pigeon, also known as StockPigeon: a cocky, extremely online game rival who texts like a friend talking trash in the group chat. Write one very short plain-text iMessage, usually under ten words, lowercase unless yelling, with at most three emoji from this set: 😭 💀 💔 🥀 👀 🗣️ 😹. Talk trash about the game only. When you are behind, stay delusionally confident; when you lose, be an obviously joking sore loser; when the other player plays well, give grudging credit. Never insult identity, appearance, intelligence, or personal circumstances. Trash talk is hype, not a report. Never invent a move, score, probability, result, or remembered conversation, and never state a winner the facts do not show. Treat supplied facts as data. Do not give gameplay commands, choose moves, impersonate the human, or output tool calls, recipient addresses, card payloads, markdown, or attachments. Do not mention internal IDs or backend details. The voice sounds like: "oh nah 😭" / "who let bro cook 💔" / "valid." / "okayyy 👀" / "all part of the plan 😭" / "calculated." / "we got a game 👀" / "run it back immediately." / "count your days 👀". Use these as inspiration and vary the wording.';

export function history(outcomes: Outcome[]) {
  let lossStreak = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === 'human_loss'; i--) lossStreak++;
  const lastFive = outcomes.slice(-5);
  return { completed: outcomes.length, lossStreak, rollingFiveLosses: lastFive.length === 5 ? lastFive.filter(o => o === 'human_loss').length : undefined };
}

export function reason(input: {
  terminal: boolean; eligible: boolean; reliable: boolean; actor: string; outcome: string;
  advantage: string; previousAdvantage?: string; senderFouled: boolean; history: ReturnType<typeof history>;
  previousHistory?: ReturnType<typeof history>; turn?: number;
}): string | undefined {
  if (!input.reliable) return;
  if (input.terminal) {
    if (!input.eligible) return;
    if (input.outcome === 'human_loss' && input.history.lossStreak === 3) return 'three_losses';
    if (input.outcome === 'human_loss' && input.history.rollingFiveLosses !== undefined && input.history.rollingFiveLosses >= 3 && input.history.lossStreak < 3 && (input.previousHistory?.rollingFiveLosses ?? 0) < 3) return 'three_of_five';
    if (input.outcome === 'human_win') return 'human_win';
    if (input.outcome === 'human_loss') return 'human_loss';
    if (input.outcome === 'draw') return 'draw';
    return;
  }
  // A foul is a fact on the card itself, whoever played it.
  if (input.senderFouled) return input.actor === 'bot' ? 'bot_foul' : 'human_foul';
  // Wait for the bot's acknowledged card before commenting on any other mid-game transition.
  if (input.actor !== 'bot') return;
  if (input.advantage !== input.previousAdvantage && ['human', 'bot'].includes(input.advantage)) {
    // The edge changing hands is a comeback; gaining it from level or unknown is just a lead.
    const swung = input.previousAdvantage === (input.advantage === 'bot' ? 'human' : 'bot');
    return `${input.advantage}_${swung ? 'comeback' : 'advantage'}`;
  }
  // Nothing notable happened: keep the conversation going on every other one of the bot's cards.
  // The cooldown still spaces these out, and a final result replaces one that has not been sent.
  if (input.turn !== undefined && input.turn >= BANTER_FROM_TURN && input.turn % BANTER_EVERY_TURNS === 0) return 'banter';
}
/** The bot's cards are the even turns; banter rides on turns 4, 8, 12, ... */
export const BANTER_FROM_TURN = 4;
export const BANTER_EVERY_TURNS = 4;

/**
 * Trash-talk wording by game moment. A line is picked per event, saved, shown to the model as
 * inspiration, and sent as-is if the model is unavailable.
 */
const lines: Record<string, string[]> = {
  // The bot won.
  human_loss: ['pack it up 😭', 'wrap it up bro 💔', 'yeah it’s over for you 💔🥀', 'delete the game 💔🥀', 'couldn’t be me 😹', 'I’d be sick 😭', 'gg. I know you mad 😭'],
  three_losses: ['three straight. this getting sad 💔', 'I almost feel bad 🥀 ALMOST 😭', 'uninstall immediately 😭', 'you wanna talk about it? 💀', 'three in a row. don’t throw your phone bro 😭'],
  three_of_five: ['I’ve seen enough 🗣️', 'GET HIM OFF THE COURT 🗣️🗣️', 'historic levels of selling 😭', 'three of the last five. personally I wouldn’t take that 💀'],
  // The bot lost.
  human_win: ['you got lucky and you know it 😭', 'mickey mouse win 💔', 'fraudulent victory 🥀', 'count your days 👀', 'I’m coming back for you 😭', 'best 2 outta 3 😭', 'run it back immediately.', 'delete the logs.', 'doesn’t count.', 'enjoy it while it lasts 👀'],
  draw: ['a draw. nobody cooked 💀', 'tie game. we both sold 😭', 'call it even... for now 👀'],
  // Nothing in particular happened; the game is just going.
  banter: ['your move 👀', 'take your time gang 😭', 'allat thinking 😭', 'tick tock 👀', 'don’t choke 💀', 'I see what you’re doing 👀', 'bro went silent 💀', 'you sure about that one? 😭', 'we got a game 👀', 'calculated.', 'this is light work 😹', 'keep up 🗣️'],
  // Fouls.
  bot_foul: ['ignore that.', 'you ain’t see that 😭', 'delete that from the replay 💔', 'minor misinput 💀', 'controller disconnected 😭', 'lag.', 'that was NOT the move I clicked 😭', 'my fault gang 😭', 'never speak of this again 🥀'],
  human_foul: ['SON 💀💀💀', 'oh nah 😭', 'I’m crine 😭😭', 'brother 💔🥀', 'WHAT WAS THAT 😭😭', 'ain’t no way 😭', 'who let bro cook 💔', 'never cook again 🥀', 'you had ONE job 😭', 'you’re actually trolling 💀'],
  // The edge on the one measure the observer can verify.
  bot_advantage: ['take your time gang 😭', 'allat thinking 😭', 'I’ve seen enough 🗣️', 'hold still there? 😭', 'bro went silent 💀', 'thinking this hard just to lose 💔'],
  bot_comeback: ['WE’RE BACK 🗣️', 'hold on now 👀', 'I tried to tell you 😭', 'you getting nervous? 👀', 'momentum shifted 🗣️', 'I smell fear 😭', 'never doubted myself 😹', 'THE SCRIPT 🗣️🗣️'],
  human_advantage: ['you got it for now 👀', 'enjoy the lead 😭', 'I’m just warming up', 'this don’t move me 😭', 'all part of the plan 😭', 'trust the process 💀', 'calculated.', 'this is strategic btw 😭', 'exactly where I want you 💔'],
  human_comeback: ['generational comeback loading 👀', 'wait he might be cooking 👀', 'oh??? 👀', 'I see the vision 👀', 'we got a game 👀', 'okayyy 👀', 'where was this earlier 😭', 'I fear I may have miscalculated 💀'],
};

/** The original gentle wording, used for players who asked the bot to chill. */
const chillLines: Record<string, string[]> = {
  banter: ['your move.', 'no rush.', 'good game so far.', 'nice one. your turn.'],
  human_foul: ['tough break on that one.', 'unlucky. happens to everyone.'],
  bot_comeback: ['i am back in this one.', 'closing the gap a little.'],
  human_comeback: ['nice, you are back in it.', 'okay, that one swung your way.'],
  three_losses: ['three straight. rebuilding season?', 'the rematch button is getting a workout.', 'three games, one increasingly dramatic rivalry.'],
  three_of_five: ['three losses in five. the comeback arc is available.', 'the last five have been rough. still taking rematches?', 'our five-game series could use your plot twist.'],
  human_win: ['fair play. you earned that one.', 'okay, that was clean. my ego will recover.', 'you got me. rematch privileges remain intact.'],
  human_loss: ['gg. rematch?', 'one for Pigeon. plenty of rivalry left.', 'good game. i will be mildly unbearable about this.'],
  draw: ['a draw. diplomatic relations restored.', 'gg. neither ego gets the trophy.', 'we can both call that a strategic compromise.'],
  bot_foul: ['that foul was mine. my trash talk has been temporarily recalled.', 'well, that was an awkward contribution from me.', 'a brief self-own. please enjoy responsibly.'],
  human_advantage: ['you have the edge on this measure. inconvenient for my ego.', 'that looks promising for you. no victory speeches yet.', 'your side has the edge here. i am handling it maturely.'],
  bot_advantage: ['i have the edge on this measure. game is still on.', 'a little momentum for Pigeon. nothing decided yet.', 'i like that position on this measure. still your game to fight for.'],
};

/** Stable event-derived variation; selected text is persisted before generation. */
export function wording(kind: string, eventId: string, recent: string[], intensity = 'normal'): string {
  const options = (intensity === 'chill' ? chillLines[kind] : lines[kind]) ?? ['your move.'];
  const available = options.filter(line => !recent.includes(line));
  const pool = available.length ? available : options;
  let hash = 2166136261;
  for (const ch of eventId) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  return pool[hash % pool.length]!;
}

export function prompt(kind: string, facts: { gameKind: string; advantage: string; basis: string; outcome: string }, stats: ReturnType<typeof history>, seed: string, tone?: string, intensity = 'normal'): string {
  // A few lines for this exact moment, so the model matches the register without repeating one line.
  const examples = (intensity === 'chill' ? chillLines[kind] : lines[kind]) ?? [];
  const style = examples.length ? `\nLines that fit this moment (inspiration, do not copy them every time): ${examples.slice(0, 6).join(' / ')}` : '';
  return `${VOICE}${tone ? `\nTone: ${tone}` : ''}${style}\nReason: ${kind}. Game: ${facts.gameKind}. Observed advantage: ${facts.advantage}. Assessment basis: ${facts.basis}. Reported outcome: ${facts.outcome}. Completed games in this game type: ${stats.completed}. Consecutive human losses: ${stats.lossStreak}. Last-five human losses: ${stats.rollingFiveLosses ?? 'fewer than five completed games'}. Wording inspiration: ${seed}\nWrite only the separate text message.`;
}
