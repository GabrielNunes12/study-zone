# Study Zone

**Spaced retrieval practice for the cards you already write in your notes, tuned to keep you in the zone where learning is fastest.**

Most flashcard tools stop at "show the answer, rate it". Study Zone adds the parts that research says make memory last: you **type an attempt** before you can reveal, you **commit to a confidence level**, new material unlocks **one step at a time (n+1)**, every session aims at **~85% correct**, and every few answers you're asked to **go deeper**: why is it true, when is it wrong, how does it apply to *your* work.

XP and levels reward effort, not ease: a hard-won correct answer pays more than an easy one.

## Quick start

1. In any note, add a deck tag and some cards:

   ```markdown
   ## Recall
   #flashcards/kafka
   Why do Kafka topics have partitions?::So consumers in a group can read in parallel.
   Where is message order guaranteed?::Only within a single partition.
   ```

2. Click 🎓 in the ribbon. Tick a topic (up to 3), then press **▶ Study**.
3. That's it. Cards come back in days, then weeks, then months. New notes join automatically.

The card syntax is the same `question::answer` line format used by the *Spaced Repetition* plugin, so existing cards work as-is. `#flashcards` without a topic uses the note's folder name as the topic. A `::` inside inline code (`` `String::valueOf` ``) is ignored.

## What a session asks of you, and why

| Step | The friction | Why it works |
|---|---|---|
| **Type an answer** | *Reveal* stays locked until you type an attempt (12+ characters by default) | Retrieving a memory strengthens it far more than re-reading it ([Roediger & Karpicke 2006](https://doi.org/10.1111/j.1467-9280.2006.01693.x); [Karpicke & Roediger 2008](https://doi.org/10.1126/science.1152408)). |
| **Say how sure you are** | Guessing / Unsure / Sure, before revealing | Separates knowing from feeling familiar. A **confident miss** asks for one line on "what was the gap?", because high-confidence errors are the ones memory corrects best ([Butterfield & Metcalfe 2001](https://doi.org/10.1037/0278-7393.27.6.1491)). |
| **Grade yourself** | Again · Hard · Good · Easy (keys 1–4) | SM-2-style spacing like Anki. Gaps of days let sleep consolidate the memory ([Cepeda et al. 2006](https://doi.org/10.1037/0033-2909.132.3.354)). |
| **Go deeper** | Every 3 correct answers, write 2–3 sentences | *Why is it true? When is it wrong? How does it apply to my context? How does it connect to [[linked note]]?* Meaning and self-relevance make memory durable ([Craik & Lockhart 1972](https://doi.org/10.1016/S0022-5371(72)80001-X); [Symons & Johnson 1997](https://doi.org/10.1037/0033-2909.121.3.371)). Answers are saved into the note under `## My explanation`. |
| **Explain the whole note** | Once all a note's cards are learned: free recall, then ✓/✗ per key idea | Rebuilds the full picture from memory. The ✗ ideas are the only ones worth re-reading. |

## How it picks what comes next

- **n+1 unlocking.** If a topic has a map-of-content note (frontmatter `type: moc`, or a name ending in ` MOC`), the links under its `## Learning path` heading set the order. A note's cards unlock only after **every card of the previous note was answered correctly once**. The dashboard shows `Next step: …` or `🔒 Finish … first`. Without a MOC, notes unlock in path order.
- **The 85% zone.** The session tracks your last 8 answers. Above 90% it adds the next step (🔵); below 70% it stops adding and repeats misses (🟠); in between you're in the zone (🟢). Based on [Wilson et al. 2019, "The Eighty Five Percent Rule for optimal learning"](https://doi.org/10.1038/s41467-019-12552-4).
- **Smaller step on repeated failure.** Miss a card twice and the retry shows one key idea from the note as a hint.
- **Interleaving.** Due cards from your selected topics are mixed round-robin ([Rohrer & Taylor 2007](https://doi.org/10.1007/s11251-007-9015-8)).
- **Max 3 topics at once** (configurable). Depth beats breadth.

## XP and levels

| Action | XP |
|---|---|
| Correct, Hard | 12 |
| Correct, Good | 10 |
| Correct, Easy | 6 |
| Wrong, but you tried | 2 |
| Confidence matched the result | +3 |
| Deep answer saved | +15 |
| Explained a whole note | 15 + 5 per key idea covered |

Levels follow *Shu-Ha-Ri*: **Shu** (1–9, follow the basics) → **Ha** (10–19, adapt) → **Ri** (20+, it's natural). Every topic also has its own level, plus a daily goal and a streak.

## Optional note conventions

These unlock extra features, and none of them is required:

```markdown
> [!summary]
> One-sentence claim in your own words.

## Key ideas
- Each bullet is a claim with a reason. These drive "explain from memory" and hints.

## Connections
- [[Another note]] — used by the "connect it" prompt.
```

## Settings

- **My context:** a sentence about your work or goals, used by the "adapt it to your context" prompt.
- **Watched folders:** empty means the whole vault.
- **Friction:** minimum answer length, confidence step on/off, deep prompt frequency, minimum deep answer length.
- **Session:** answers per session, new notes (n+1 steps) per session, max topics, daily XP goal.
- **Writing to frontmatter** (off by default): sync `status: active/paused` into a topic's MOC, and `status: growing/evergreen` into notes as their cards mature.

## Privacy

Everything stays in your vault. Review history is stored in the plugin's `data.json`. The plugin makes no network requests. It writes to your notes only when you save a deep answer or explanation (toggleable), or when the optional frontmatter settings are on.

## Install

- **Community plugins:** search for "Study Zone" (once listed).
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/GabrielNunes12/study-zone/releases/latest) into `<vault>/.obsidian/plugins/study-zone/`, then enable it in *Community plugins*.

## Development

Plain JavaScript, no build step. `npm test` runs the logic tests (parser, scheduler, zone controller, n+1 gate) against a stubbed Obsidian API.

## License

[MIT](LICENSE) © Gabriel Nunes Medeiros
