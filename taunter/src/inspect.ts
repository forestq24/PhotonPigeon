/**
 * Safe diagnostics: counts and statuses only. Never prints message text, prompts, handles or keys.
 * Lists uncertain sends so an operator can check the phone and settle them with:
 *   spacetime call <database> resolve_send '"<id>"' true|false
 */
import { openStore } from './store.ts';

if (!process.env.SPACETIME_DATABASE) throw new Error('Configure SPACETIME_DATABASE');
const connection = await openStore();
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Subscription timeout')), 5000);
    connection.subscriptionBuilder().onApplied(() => { clearTimeout(timeout); resolve(); })
      .onError(() => { clearTimeout(timeout); reject(new Error('Subscription failed')); })
      .subscribe(['SELECT * FROM my_outbox', 'SELECT * FROM my_probes', 'SELECT * FROM my_players', 'SELECT * FROM my_conversation', 'SELECT * FROM my_memory_facts', 'SELECT * FROM reaction_images', 'SELECT * FROM my_image_choices']);
  });
  const tally = (rows: Iterable<{ status: string }>) => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  };
  const outbox = [...connection.db.myOutbox.iter()];
  console.log('generation jobs by status:', tally(connection.db.myProbes.iter()));
  console.log('outbox by status:', tally(outbox));
  console.log(`players: ${Number(connection.db.myPlayers.count())}, stored messages: ${Number(connection.db.myConversation.count())}, remembered facts: ${Number(connection.db.myMemoryFacts.count())}`);
  const quiet = [...connection.db.myPlayers.iter()].filter(player => !player.unsolicited).length;
  console.log(`players who asked for no unprompted banter: ${quiet}`);
  const images = [...connection.db.reactionImages.iter()];
  const bucketed = (rows: Iterable<{ bucket: string }>) => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.bucket] = (counts[row.bucket] ?? 0) + 1;
    return counts;
  };
  console.log('reaction images switched on, by bucket:', bucketed(images.filter(image => image.enabled)), `(${images.filter(image => !image.enabled).length} switched off)`);
  console.log('images chosen for reactions, by bucket (sent only after the text, and only with TAUNTER_IMAGES_ENABLED=1):', bucketed(connection.db.myImageChoices.iter()));
  const uncertain = outbox.filter(row => row.status === 'uncertain');
  console.log(uncertain.length ? `uncertain sends (never resent automatically):\n${uncertain.map(row => `  ${row.id} (${row.kind})`).join('\n')}` : 'no uncertain sends');
} finally { connection.disconnect(); }
