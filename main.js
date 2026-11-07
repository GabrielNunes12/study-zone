/* Study Zone — spaced retrieval practice inside your vault.
 *
 * What it does, and the evidence behind each piece:
 *  1. Retrieval practice: you TYPE an answer before you may reveal (Roediger & Karpicke 2006; Karpicke & Roediger 2008).
 *  2. Spacing: Anki-style intervals in days, so sleep consolidates between reviews (Cepeda et al. 2006; Diekelmann & Born 2010).
 *  3. n+1 / Zone of Proximal Development: new notes unlock one at a time, in the order of the topic's MOC learning path,
 *     only after the current note's cards were all answered correctly once (Vygotsky; Krashen's i+1; Kumon).
 *  4. The 85% zone: the session adds new material when you're above ~90% and stops when you drop below ~70%
 *     (Wilson et al. 2019, "The Eighty Five Percent Rule for optimal learning").
 *  5. Confidence before reveal + reflection on confident errors (hypercorrection: Butterfield & Metcalfe 2001).
 *  6. Deep processing prompts after correct answers — why / critique / adapt-to-my-context / connect
 *     (Craik & Lockhart 1972; elaborative interrogation, Pressley et al. 1987; self-reference effect, Symons & Johnson 1997).
 *  7. Interleaving: due cards are mixed round-robin across topics (Rohrer & Taylor 2007).
 *  8. XP and levels reward *desirable difficulty*: a Hard success pays more than an Easy one.
 *
 * Card syntax (unchanged, already in the notes):   question::answer   on its own line, below a  #flashcards/<topic>  tag.
 * Scheduling state lives in this plugin's data.json, so notes stay clean.
 */
const obsidian = require('obsidian');
const { Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab, MarkdownRenderer, TFile, moment, normalizePath } = obsidian;

const VIEW_TYPE = 'study-zone';

const DEFAULT_SETTINGS = {
  watchedFolders: [],          // empty = whole vault
  maxActiveTopics: 3,
  sessionLength: 20,
  newNotesPerSession: 2,
  minAnswerChars: 12,
  minDeepChars: 60,
  requireConfidence: true,
  deepEvery: 3,
  dailyGoalXp: 60,
  saveDeepAnswers: true,
  myContext: '',
  syncMocStatus: false,        // write status: active/paused into a topic's MOC when you (un)select it
  updateNoteStatus: false,     // write status: growing/evergreen into notes as their cards mature
};

const freshState = () => ({
  cards: {},        // id -> { p, due, ivl, ease, reps, lapses, last, seen }
  notes: {},        // path -> same schedule fields, for "explain from memory"
  xp: 0, topicXp: {}, selected: [],
  streak: { last: null, count: 0 },
  days: {},         // YYYY-MM-DD -> { xp, answered, correct, sureWrong }
  known: {},        // path -> date first indexed (drives "recently added")
});

// ───────────────────────── utils ─────────────────────────
const today = () => moment().format('YYYY-MM-DD');
const addDays = (n) => moment().add(n, 'days').format('YYYY-MM-DD');
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const slugify = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
const STOP = new Set(('a o os as um uma de do da dos das em no na nos nas por para com sem que se ou e é ser são foi como mais menos muito pode quando onde qual isso esse essa este esta ele ela seu sua nao não já entre sobre até também cada outro outra ' +
  'the an and or of to in on for with without that this these those is are was were be been it its as at by from into than then so such can could should would will may might not no also each other more most less very when where which who what why how your you they them their there here about between does do did have has had using use used only just like get got make made').split(' '));
const tokens = (s) => norm(s).replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
function overlap(expected, answer) {
  const want = [...new Set(tokens(expected).map((w) => w.slice(0, 5)))];
  if (!want.length) return null;
  const have = new Set(tokens(answer).map((w) => w.slice(0, 5)));
  return want.filter((w) => have.has(w)).length / want.length;
}
const cardId = (path, q) => hash(path + '|' + norm(q).replace(/\s+/g, ' ').trim());

// ───────────────────────── parsing ─────────────────────────
/** Split "question::answer" on the first :: (or :::) that is outside inline `code`, so `String::valueOf` stays intact. */
function splitCard(line) {
  const l = line.replace(/^\s*(?:[-*]\s+)?/, '');
  if (!l || l.startsWith('#') || l.startsWith('|')) return null;
  let inCode = false;
  for (let i = 0; i < l.length - 1; i++) {
    if (l[i] === '`') inCode = !inCode;
    else if (!inCode && l[i] === ':' && l[i + 1] === ':') {
      const q = l.slice(0, i).trim();
      const a = l.slice(l[i + 2] === ':' ? i + 3 : i + 2).replace(/<!--SR:.*?-->/g, '').trim();
      return q && a ? { q, a } : null;
    }
  }
  return null;
}
/** Extract cards, summary, key ideas and connection links. Stops at the archived "Original notes" callout. */
function parseNote(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const out = { summary: [], ideas: [], cards: [], links: [], deck: null };
  let section = null, inCode = false, inSummary = false, deck = null;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (/^>\s*\[!summary\]/i.test(line)) { inSummary = true; continue; }
    if (inSummary) {
      if (line.startsWith('>')) { const t = line.replace(/^>\s?/, ''); if (t) out.summary.push(t); continue; }
      inSummary = false;
    }
    if (line.startsWith('>')) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    const tag = line.match(/(?:^|\s)#flashcards(?:\/([\w-]+))?/);
    if (tag) { deck = tag[1] || '*'; if (!out.deck && tag[1]) out.deck = deck; continue; }
    if (section === 'key ideas' && /^\s*[-*]\s+/.test(line)) out.ideas.push(line.replace(/^\s*[-*]\s+/, ''));
    if (section === 'connections') for (const m of line.matchAll(/\[\[([^\]|#]+)[^\]]*\]\]/g)) out.links.push(m[1].trim());
    if (!deck || section === 'my explanation') continue;
    const c = splitCard(line);
    if (c) out.cards.push({ q: c.q, a: c.a, deck });
  }
  out.summary = out.summary.join(' ');
  return out;
}

// ───────────────────────── scheduler (SM-2 style, like Anki) ─────────────────────────
function schedule(prev, grade, fuzz = true) {
  const s = Object.assign({ ivl: 0, ease: 2.5, reps: 0, lapses: 0 }, prev);
  if (grade === 'again') { s.lapses++; s.reps = 0; s.ivl = 0; s.ease = Math.max(1.3, s.ease - 0.2); }
  else if (grade === 'hard') { s.ivl = s.ivl ? Math.max(s.ivl + 1, Math.round(s.ivl * 1.2)) : 1; s.ease = Math.max(1.3, s.ease - 0.15); s.reps++; }
  else if (grade === 'good') { s.ivl = s.reps === 0 ? 1 : s.reps === 1 ? Math.max(3, s.ivl + 1) : Math.round(s.ivl * s.ease); s.reps++; }
  else { s.ivl = s.reps === 0 ? 4 : Math.round(Math.max(s.ivl, 1) * s.ease * 1.3); s.ease += 0.15; s.reps++; }
  if (fuzz && s.ivl > 7) s.ivl = Math.round(s.ivl * (0.95 + Math.random() * 0.1));
  s.ivl = Math.min(s.ivl, 365);
  s.due = addDays(s.ivl); s.last = today(); s.seen = true;
  return s;
}
const ivlLabel = (d) => (d === 0 ? 'today' : d < 30 ? `${d}d` : d < 365 ? `${Math.round(d / 30)}mo` : '1y');

// ───────────────────────── XP & levels ─────────────────────────
const CARD_XP = { again: 2, hard: 12, good: 10, easy: 6 };
function levelInfo(xp) {
  let level = 1, need = 100, rem = xp;
  while (rem >= need) { rem -= need; level++; need = 100 + 40 * (level - 1); }
  return { level, into: rem, need };
}
function levelTitle(l) {
  if (l < 5) return 'Shu · Beginner';
  if (l < 10) return 'Shu · Follower';
  if (l < 15) return 'Ha · Adapter';
  if (l < 20) return 'Ha · Breaker';
  return 'Ri · Natural';
}

// ───────────────────────── zone controller (85% rule) ─────────────────────────
function zoneOf(results) {
  const r = results.slice(-8);
  if (r.length < 4) return { key: 'warm', label: '⚪ Warming up', tip: 'A few answers first, then the session adapts to you.' };
  const acc = r.reduce((a, b) => a + b, 0) / r.length;
  if (acc > 0.9) return { key: 'easy', acc, label: '🔵 Too easy → adding the next step (n+1)', tip: 'Above 90%: you are ready for something new.' };
  if (acc < 0.7) return { key: 'hard', acc, label: '🟠 Too hard → consolidating', tip: 'Below 70%: no new material until the misses stick.' };
  return { key: 'zone', acc, label: '🟢 In the zone (~85%)', tip: 'Hard enough to learn, easy enough to keep going.' };
}

const DEEP_PROMPTS = {
  adapt: (ctx) => `**Adapt it to your context** (${ctx || 'your own work, projects or life'}): where would you use — or deliberately avoid — this in real work? Be concrete.`,
  critique: () => '**Critique it:** when is this wrong, overkill or risky? Give one limitation or counter-example.',
  why: () => '**Why is it true?** Explain the mechanism (cause → effect), not the definition.',
  connect: (_, link) => `**Connect it:** how does this relate to [[${link}]]? Same idea, opposite, or does one build on the other?`,
};
const DEEP_ORDER = ['adapt', 'critique', 'why', 'connect', 'adapt', 'critique'];

// ───────────────────────── session engine (no UI) ─────────────────────────
class Session {
  constructor(plugin, { slugs, mode, notePath }) {
    this.p = plugin; this.slugs = slugs; this.mode = mode;
    this.results = []; this.answered = 0; this.correct = 0; this.xp = 0; this.newLearned = 0; this.sureWrong = []; this.deepCount = 0;
    this.correctStreakForDeep = 0;
    const s = plugin.settings;
    if (mode === 'note') {
      this.queue = plugin.itemsForNote(notePath);
      this.newBudget = 0;
    } else {
      this.queue = plugin.interleave(plugin.dueItems(slugs)).slice(0, s.sessionLength);
      this.newBudget = mode === 'review' ? 0 : s.newNotesPerSession;
    }
    this.limit = mode === 'note' ? this.queue.length * 2 : Math.round(s.sessionLength * 1.5);
    this.rr = 0;
    if (!this.queue.length) this.injectNew();
  }
  zone() { return zoneOf(this.results); }
  /** Pull the next n+1 step (one note's unseen cards, or an explain item) from the selected topics, round-robin. */
  injectNew() {
    if (this.newBudget <= 0) return false;
    for (let k = 0; k < this.slugs.length; k++) {
      const slug = this.slugs[(this.rr + k) % this.slugs.length];
      const step = this.p.frontier(slug);
      if (step && step.items.length) {
        this.rr = (this.rr + k + 1) % this.slugs.length;
        const queued = new Set(this.queue.map((i) => i.key));
        const items = step.items.filter((i) => !queued.has(i.key)).map((i) => Object.assign(i, { isNew: true }));
        if (!items.length) continue;
        this.queue.unshift(...items);
        this.newBudget--;
        return true;
      }
    }
    return false;
  }
  next() {
    if (this.answered >= this.limit) return null;
    return this.queue.shift() || null;
  }
  /** Record a graded answer; returns feedback for the UI. */
  record(item, grade, { confidence, retry }) {
    const ok = grade !== 'again';
    this.answered++; if (ok) this.correct++;
    this.results.push(ok ? 1 : 0);
    const sureWrong = confidence === 'sure' && !ok;
    const calibrated = (confidence === 'sure' && ok) || (confidence === 'guess' && !ok);
    let xp = item.kind === 'explain' ? 0 : CARD_XP[grade];
    if (retry) xp = Math.floor(xp / 2);
    if (calibrated && confidence) xp += 3;
    if (sureWrong) this.sureWrong.push(item);
    if (item.isNew && ok) this.newLearned++;
    this.xp += xp;
    if (!ok) {
      // Deep Practice: fail → retry soon, shrunk with a hint on the 2nd miss.
      const again = Object.assign({}, item, { retry: true, hint: !!item.retry, isNew: false });
      this.queue.splice(Math.min(3, this.queue.length), 0, again);
    }
    let deep = false;
    if (ok && item.kind === 'card') { this.correctStreakForDeep++; if (this.correctStreakForDeep >= this.p.settings.deepEvery) { deep = true; this.correctStreakForDeep = 0; } }
    return { xp, sureWrong, deep, zone: this.zone() };
  }
  /** Call AFTER the grade is saved, so the n+1 gate sees the card's new state. */
  afterGrade() {
    const z = this.zone();
    if (this.mode === 'topics' && (z.key === 'easy' || (z.key !== 'hard' && this.queue.length < 2))) this.injectNew();
  }
  deepKind(item) {
    const kind = DEEP_ORDER[this.deepCount++ % DEEP_ORDER.length];
    const links = (this.p.index.get(item.notePath) || {}).links || [];
    if (kind === 'connect' && !links.length) return { kind: 'why' };
    return { kind, link: links[Math.floor(Math.random() * links.length)] };
  }
}

// ───────────────────────── session UI ─────────────────────────
class SessionModal extends Modal {
  constructor(plugin, session) { super(plugin.app); this.p = plugin; this.s = session; }
  onOpen() {
    this.modalEl.addClass('sz-modal');
    this.scope.register(['Mod'], 'Enter', () => { this.onModEnter && this.onModEnter(); return false; });
    for (const [k, g] of [['1', 'again'], ['2', 'hard'], ['3', 'good'], ['4', 'easy']]) {
      this.scope.register([], k, (evt) => {
        if (this.onGrade && !(evt.target instanceof HTMLTextAreaElement)) { this.onGrade(g); return false; }
        return true;
      });
    }
    this.advance();
  }
  onClose() {
    this.contentEl.empty();
    if (!this.finished && this.s.answered) this.p.finishSession(this.s);
  }
  clearHandlers() { this.onModEnter = null; this.onGrade = null; }
  header(item) {
    const { contentEl } = this; contentEl.empty(); this.clearHandlers();
    const top = contentEl.createDiv('sz-top');
    const topic = this.p.topicName(item.slug);
    top.createSpan({ cls: 'sz-chip', text: topic });
    if (item.isNew) top.createSpan({ cls: 'sz-chip sz-new', text: 'new · n+1' });
    if (item.retry) top.createSpan({ cls: 'sz-chip sz-retry', text: 'retry' });
    const z = this.s.zone();
    top.createSpan({ cls: 'sz-zone', text: z.label, attr: { title: z.tip } });
    top.createSpan({ cls: 'sz-count', text: `${this.s.answered + 1} · ${this.s.queue.length} left · +${this.s.xp} XP` });
    return contentEl;
  }
  async md(el, text, path) { await MarkdownRenderer.render(this.app, text, el, path || '', this.p); }

  advance() {
    const item = this.s.next();
    if (!item) return this.renderSummary();
    this.item = item;
    if (item.kind === 'explain') this.renderExplain(item); else this.renderCard(item);
  }

  // ── card: answer → confidence → reveal ──
  async renderCard(item) {
    const el = this.header(item);
    this.titleEl.setText(item.retry ? 'Try again — smaller step' : 'Recall');
    const q = el.createDiv('sz-q'); await this.md(q, item.q, item.notePath);
    if (item.hint) {
      const hint = this.p.hintFor(item);
      if (hint) { const h = el.createDiv('sz-hint'); h.createEl('b', { text: 'Hint (one idea from the note): ' }); await this.md(h, hint, item.notePath); }
    }
    const ta = el.createEl('textarea', { cls: 'sz-textarea', attr: { rows: '4', placeholder: 'Type your answer from memory. No peeking — messy is fine, the effort is the exercise.' } });
    const min = this.p.settings.minAnswerChars;
    let confidence = null;
    const confRow = el.createDiv('sz-row');
    if (this.p.settings.requireConfidence) {
      confRow.createSpan({ cls: 'sz-label', text: 'How sure are you?' });
      for (const [k, label] of [['guess', 'Guessing'], ['unsure', 'Unsure'], ['sure', 'Sure']]) {
        const b = confRow.createEl('button', { text: label, cls: 'sz-conf' });
        b.onclick = () => { confidence = k; confRow.querySelectorAll('.sz-conf').forEach((x) => x.removeClass('is-active')); b.addClass('is-active'); update(); };
      }
    }
    const row = el.createDiv('sz-row');
    const reveal = row.createEl('button', { text: 'Reveal answer', cls: 'mod-cta' });
    const dunno = row.createEl('button', { text: "I don't know" });
    const gate = el.createDiv('sz-gate');
    const update = () => {
      const left = Math.max(0, min - ta.value.trim().length);
      const needConf = this.p.settings.requireConfidence && !confidence;
      reveal.disabled = left > 0 || needConf;
      gate.setText(left > 0 ? `${left} more characters to unlock — retrieval needs an attempt.` : needConf ? 'Pick how sure you are (it trains your judgment of what you really know).' : 'Ctrl/Cmd+Enter to reveal');
    };
    ta.addEventListener('input', update); update();
    setTimeout(() => ta.focus(), 30);
    const go = () => { if (!reveal.disabled) this.renderReveal(item, ta.value, confidence); };
    reveal.onclick = go; this.onModEnter = go;
    dunno.onclick = () => this.grade(item, 'again', { answer: '', confidence: null });
  }

  async renderReveal(item, answer, confidence) {
    const el = this.header(item);
    this.titleEl.setText('Compare, then grade yourself honestly');
    const q = el.createDiv('sz-q sz-small'); await this.md(q, item.q, item.notePath);
    const grid = el.createDiv('sz-grid');
    const a = grid.createDiv('sz-col'); a.createEl('h4', { text: 'You' }); a.createDiv({ cls: 'sz-answer', text: answer });
    const b = grid.createDiv('sz-col sz-correct'); b.createEl('h4', { text: 'Note' }); await this.md(b, item.a, item.notePath);
    const ov = overlap(item.a, answer);
    if (ov !== null) el.createDiv({ cls: 'sz-hint-muted', text: `Keyword overlap ≈ ${Math.round(ov * 100)}% (a rough hint — meaning matters more than words).` });
    const row = el.createDiv('sz-row sz-grades');
    const st = this.p.stateOf(item);
    for (const [g, label] of [['again', 'Again'], ['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']]) {
      const next = schedule(st, g, false);
      const btn = row.createEl('button', { cls: g === 'good' ? 'mod-cta' : '', text: `${label} · ${g === 'again' ? 'soon' : ivlLabel(next.ivl)}` });
      btn.onclick = () => this.grade(item, g, { answer, confidence });
    }
    el.createDiv({ cls: 'sz-hint-muted', text: 'Keys 1–4. Again = missed the core idea · Hard = got it with effort · Good = got it · Easy = instant.' });
    this.onGrade = (g) => this.grade(item, g, { answer, confidence });
  }

  async grade(item, grade, { answer, confidence }) {
    this.clearHandlers();
    const fb = this.s.record(item, grade, { confidence, retry: !!item.retry });
    await this.p.applyGrade(item, grade, fb.xp, { sureWrong: fb.sureWrong, isNew: item.isNew });
    this.s.afterGrade();
    if (fb.sureWrong) return this.renderReflect(item, answer);
    if (fb.deep) return this.renderDeep(item);
    this.advance();
  }

  // ── friction after a confident miss (hypercorrection) ──
  async renderReflect(item, answer) {
    const el = this.header(item);
    this.titleEl.setText('🔥 Confident miss — the best moment to learn');
    el.createEl('p', { text: 'You were sure and it was wrong. These errors are the ones memory fixes best, if you name the gap now.' });
    const g = el.createDiv('sz-grid');
    g.createDiv('sz-col').createDiv({ cls: 'sz-answer', text: answer || '(blank)' });
    const c = g.createDiv('sz-col sz-correct'); await this.md(c, item.a, item.notePath);
    const ta = el.createEl('textarea', { cls: 'sz-textarea', attr: { rows: '2', placeholder: 'In one line: what exactly was the gap between my answer and the right one?' } });
    const row = el.createDiv('sz-row');
    const btn = row.createEl('button', { text: 'Continue', cls: 'mod-cta' });
    const upd = () => (btn.disabled = ta.value.trim().length < 15);
    ta.addEventListener('input', upd); upd(); setTimeout(() => ta.focus(), 30);
    const go = () => { if (!btn.disabled) this.advance(); };
    btn.onclick = go; this.onModEnter = go;
  }

  // ── deep processing: why / critique / adapt / connect ──
  async renderDeep(item) {
    const el = this.header(item);
    const { kind, link } = this.s.deepKind(item);
    this.titleEl.setText('Go deeper (+15 XP)');
    el.createDiv({ cls: 'sz-hint-muted', text: 'Shallow = recognising words. Deep = meaning, reasons, and your own situation. This step is what turns a card into understanding.' });
    const q = el.createDiv('sz-q sz-small'); await this.md(q, `${item.q}\n\n→ ${item.a}`, item.notePath);
    const p = el.createDiv('sz-deep'); await this.md(p, DEEP_PROMPTS[kind](this.p.settings.myContext, link), item.notePath);
    const ta = el.createEl('textarea', { cls: 'sz-textarea', attr: { rows: '4', placeholder: 'Write 2–3 sentences in your own words.' } });
    const gate = el.createDiv('sz-gate');
    const row = el.createDiv('sz-row');
    const save = row.createEl('button', { text: 'Save (+15 XP)', cls: 'mod-cta' });
    const skip = row.createEl('button', { text: 'Skip (no XP)' });
    const min = this.p.settings.minDeepChars;
    const upd = () => { const left = Math.max(0, min - ta.value.trim().length); save.disabled = left > 0; gate.setText(left ? `${left} more characters` : 'Ctrl/Cmd+Enter to save'); };
    ta.addEventListener('input', upd); upd(); setTimeout(() => ta.focus(), 30);
    const go = async () => {
      if (save.disabled) return;
      this.s.xp += 15;
      await this.p.award(15, item.slug);
      if (this.p.settings.saveDeepAnswers) await this.p.appendExplanation(item.notePath, `${kind} · ${item.q}`, ta.value);
      this.advance();
    };
    save.onclick = go; this.onModEnter = go;
    skip.onclick = () => this.advance();
  }

  // ── explain a whole note from memory (free recall) ──
  async renderExplain(item) {
    const el = this.header(item);
    const note = this.p.index.get(item.notePath);
    this.titleEl.setText(`Explain from memory: ${note ? note.basename : item.notePath}`);
    el.createEl('p', { cls: 'sz-hint-muted', text: 'You have learned every card of this note. Now explain the whole idea as if teaching a beginner: what it is, why it matters, an example.' });
    const ta = el.createEl('textarea', { cls: 'sz-textarea', attr: { rows: '8', placeholder: 'Everything you remember…' } });
    const min = Math.max(80, this.p.settings.minAnswerChars);
    const gate = el.createDiv('sz-gate');
    const row = el.createDiv('sz-row');
    const cmp = row.createEl('button', { text: 'Compare with the note', cls: 'mod-cta' });
    const upd = () => { const left = Math.max(0, min - ta.value.trim().length); cmp.disabled = left > 0; gate.setText(left ? `${left} more characters` : 'Ctrl/Cmd+Enter to compare'); };
    ta.addEventListener('input', upd); upd(); setTimeout(() => ta.focus(), 30);
    const go = () => { if (!cmp.disabled) this.renderExplainCompare(item, ta.value); };
    cmp.onclick = go; this.onModEnter = go;
  }

  async renderExplainCompare(item, answer) {
    const el = this.header(item);
    const note = this.p.index.get(item.notePath) || { ideas: [], summary: '' };
    const cov = note.ideas.map((idea) => ({ idea, hit: (overlap(idea, answer) || 0) >= 0.34 }));
    const got = cov.filter((c) => c.hit).length;
    this.titleEl.setText(`You touched ${got} of ${cov.length} key ideas`);
    const grid = el.createDiv('sz-grid');
    const a = grid.createDiv('sz-col'); a.createEl('h4', { text: 'You' }); a.createDiv({ cls: 'sz-answer', text: answer });
    const b = grid.createDiv('sz-col sz-correct'); b.createEl('h4', { text: 'Note' });
    if (note.summary) b.createEl('p', { cls: 'sz-summary', text: note.summary });
    const ul = b.createEl('ul');
    for (const c of cov) { const li = ul.createEl('li', { cls: c.hit ? 'sz-hit' : 'sz-miss' }); await this.md(li, (c.hit ? '✓ ' : '✗ ') + c.idea, item.notePath); }
    el.createDiv({ cls: 'sz-hint-muted', text: 'Missed ideas (✗) are exactly what to re-read — only those.' });
    const row = el.createDiv('sz-row sz-grades');
    const finish = async (g) => {
      this.clearHandlers();
      const fb = this.s.record(item, g, { confidence: null, retry: !!item.retry });
      const xp = g === 'again' ? 3 : Math.min(45, 15 + 5 * got);
      this.s.xp += xp - fb.xp;
      await this.p.applyGrade(item, g, xp, {});
      this.s.afterGrade();
      await this.p.appendExplanation(item.notePath, `explain · ${got}/${cov.length} ideas`, answer);
      this.advance();
    };
    for (const [g, label] of [['again', 'Again'], ['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']]) row.createEl('button', { text: label, cls: g === 'good' ? 'mod-cta' : '' }).onclick = () => finish(g);
    this.onGrade = finish;
  }

  renderSummary() {
    this.finished = true;
    const { contentEl } = this; contentEl.empty(); this.clearHandlers();
    const s = this.s;
    this.titleEl.setText(s.answered ? 'Session complete' : 'Nothing to study right now');
    if (!s.answered) {
      contentEl.createEl('p', { text: 'No cards are due and no new step is unlocked for the selected topics. Pick another topic on the dashboard, or come back tomorrow — spacing is part of the method.' });
    } else {
      const acc = Math.round((s.correct / s.answered) * 100);
      const ul = contentEl.createEl('ul', { cls: 'sz-summary-list' });
      ul.createEl('li', { text: `+${s.xp} XP · ${s.answered} answers · ${acc}% correct ${acc >= 70 && acc <= 92 ? '(in the zone ✓)' : acc > 92 ? '(too easy — next time more new material)' : '(hard session — that is fine, spacing will do the rest)'}` });
      ul.createEl('li', { text: `${s.newLearned} new cards learned (n+1)` });
      if (s.sureWrong.length) ul.createEl('li', { text: `${s.sureWrong.length} confident misses — they come back soon; expect them to stick.` });
      const lv = levelInfo(this.p.state.xp);
      ul.createEl('li', { text: `Level ${lv.level} · ${levelTitle(lv.level)} — ${lv.need - lv.into} XP to next level` });
      this.p.finishSession(s);
    }
    contentEl.createDiv('sz-row').createEl('button', { text: 'Close', cls: 'mod-cta' }).onclick = () => this.close();
  }
}

// ───────────────────────── dashboard view ─────────────────────────
class StudyView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.p = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Study Zone'; }
  getIcon() { return 'graduation-cap'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.p, st = p.state, el = this.contentEl;
    el.empty(); el.addClass('sz-view');
    const lv = levelInfo(st.xp);
    const d = st.days[today()] || { xp: 0 };
    const head = el.createDiv('sz-card');
    head.createEl('h2', { text: '🎓 Study Zone' });
    head.createDiv({ cls: 'sz-level', text: `Level ${lv.level} · ${levelTitle(lv.level)}` });
    bar(head, lv.into / lv.need, `${lv.into} / ${lv.need} XP`);
    head.createDiv({ cls: 'sz-meta', text: `🔥 ${st.streak.count || 0}-day streak   ·   Today ${d.xp} / ${p.settings.dailyGoalXp} XP` });
    bar(head, Math.min(1, d.xp / p.settings.dailyGoalXp), d.xp >= p.settings.dailyGoalXp ? 'Daily goal reached ✓' : 'Daily goal');

    const sel = st.selected.filter((s) => p.topics().some((t) => t.slug === s));
    const actions = el.createDiv('sz-row');
    const start = actions.createEl('button', { cls: 'mod-cta', text: sel.length ? `▶ Study ${sel.map((s) => p.topicName(s)).join(' + ')}` : '▶ Select a topic below first' });
    start.disabled = !sel.length;
    start.onclick = () => p.startSession({ slugs: sel, mode: 'topics' });
    const totalDue = p.dueItems(p.topics().map((t) => t.slug)).length;
    actions.createEl('button', { text: `Review all due (${totalDue})` }).onclick = () => p.startSession({ slugs: p.topics().map((t) => t.slug), mode: 'review' });

    const how = el.createEl('details', { cls: 'sz-how' });
    how.createEl('summary', { text: 'How this works (1 minute)' });
    const ul = how.createEl('ul');
    [
      ['Answer before you see it.', 'Typing an attempt is the workout; reading the answer is not (retrieval practice).'],
      ['Say how sure you are.', 'Confident mistakes get a short reflection — they are the errors memory fixes best.'],
      ['Grade yourself like Anki.', 'Again / Hard / Good / Easy sets when the card returns: days, then weeks, then months.'],
      ['One step at a time (n+1).', "New notes unlock in the order of the topic's MOC (map of content), only after the current one is learned."],
      ['Stay in the zone.', 'Around 85% correct is ideal: above 90% the session adds new material, below 70% it consolidates.'],
      ['Go deeper.', 'Every few correct answers: why is it true, when is it wrong, how does it apply to YOUR work. Saved into the note.'],
      ['XP rewards effort, not ease.', 'Hard successes pay most; Easy pays least. New notes in watched folders join automatically.'],
    ].forEach(([b, t]) => { const li = ul.createEl('li'); li.createEl('b', { text: b + ' ' }); li.appendText(t); });
    how.createEl('p', { cls: 'sz-meta', text: p.settings.myContext ? `Your context for "adapt" prompts: ${p.settings.myContext} (change it in the plugin options).` : 'Tip: describe your work or goals under "My context" in the plugin options, so the "adapt it to your context" prompts get personal.' });

    el.createEl('h3', { text: `Choose what to study (max ${p.settings.maxActiveTopics})` });
    const list = el.createDiv('sz-topics');
    const topics = p.topics().sort((a, b) => (sel.includes(b.slug) - sel.includes(a.slug)) || (b.due - a.due) || a.name.localeCompare(b.name));
    if (!topics.length) list.createEl('p', { text: 'No cards found yet. In any note, add a line with #flashcards/<topic> and below it lines like  Why does X happen?::Because …' });
    for (const t of topics) {
      const row = list.createDiv('sz-topic' + (sel.includes(t.slug) ? ' is-selected' : ''));
      const cb = row.createEl('input', { type: 'checkbox' }); cb.checked = sel.includes(t.slug);
      cb.onchange = () => p.toggleTopic(t.slug, cb.checked);
      const info = row.createDiv('sz-topic-info');
      const name = info.createEl('a', { text: t.name, cls: 'sz-topic-name' });
      name.onclick = () => t.mocPath && this.app.workspace.openLinkText(t.mocPath, '', false);
      const tl = levelInfo(st.topicXp[t.slug] || 0).level;
      info.createSpan({ cls: 'sz-meta', text: `  Lv ${tl} · ${t.learned}/${t.total} learned · ${t.due} due` });
      bar(info, t.total ? t.mature / t.total : 0, `${t.total ? Math.round((t.mature / t.total) * 100) : 0}% long-term (21d+)`);
      info.createDiv({ cls: 'sz-meta', text: t.next ? (t.next.locked ? `🔒 Finish “${t.next.name}” first` : `Next step: ${t.next.name}`) : 'All notes unlocked ✓' });
    }

    const added = Object.entries(st.known).filter(([path, date]) => date !== '—' && p.index.has(path)).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 6);
    if (added.length) {
      el.createEl('h3', { text: '📥 Recently added' });
      const ul2 = el.createEl('ul');
      for (const [path, date] of added) {
        const n = p.index.get(path);
        const li = ul2.createEl('li');
        li.createEl('a', { text: n.basename }).onclick = () => this.app.workspace.openLinkText(path, '', false);
        li.appendText(` · ${p.topicName(n.slug)} · ${n.cards.length} cards · ${date}`);
      }
    }
    const week = Object.entries(st.days).filter(([dd]) => dd >= moment().subtract(6, 'days').format('YYYY-MM-DD'));
    const ans = week.reduce((a, [, v]) => a + (v.answered || 0), 0), cor = week.reduce((a, [, v]) => a + (v.correct || 0), 0), sw = week.reduce((a, [, v]) => a + (v.sureWrong || 0), 0);
    if (ans) el.createDiv({ cls: 'sz-meta sz-week', text: `Last 7 days: ${ans} answers · ${Math.round((cor / ans) * 100)}% correct · ${sw} confident misses` });
  }
}
function bar(parent, frac, label) {
  const w = parent.createDiv('sz-bar');
  w.createDiv({ cls: 'sz-bar-fill' }).setCssProps({ '--sz-fill': `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%` });
  w.createSpan({ cls: 'sz-bar-label', text: label });
}

// ───────────────────────── plugin ─────────────────────────
module.exports = class StudyZone extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    this.state = Object.assign(freshState(), data.state || {});
    this.index = new Map();   // path -> { path, basename, slug, cards:[{id,q,a}], ideas, summary, links, hasFm }
    this.mocs = new Map();    // slug -> { name, path, order: Map(basename -> i) }
    this.folderSlug = new Map(); // topic folder name -> slug

    this.registerView(VIEW_TYPE, (leaf) => new StudyView(leaf, this));
    this.addRibbonIcon('graduation-cap', 'Study Zone', () => this.openDashboard());
    this.status = this.addStatusBarItem(); this.status.addClass('mod-clickable');
    this.status.onClickEvent(() => this.openDashboard());
    this.addSettingTab(new StudyZoneSettings(this.app, this));

    this.addCommand({ id: 'open-dashboard', name: 'Open dashboard', callback: () => this.openDashboard() });
    this.addCommand({ id: 'study-selected', name: 'Study selected topics', callback: () => this.startSession({ slugs: this.state.selected, mode: 'topics' }) });
    this.addCommand({ id: 'review-all', name: 'Review everything due', callback: () => this.startSession({ slugs: this.topics().map((t) => t.slug), mode: 'review' }) });
    this.addCommand({ id: 'study-note', name: 'Study the current note', checkCallback: (check) => {
      const f = this.app.workspace.getActiveFile(); const ok = f && this.index.has(f.path) && this.itemsForNote(f.path).length;
      if (ok && !check) this.startSession({ mode: 'note', notePath: f.path }); return !!ok; } });
    this.addCommand({ id: 'rebuild-index', name: 'Rebuild card index', callback: async () => { await this.fullIndex(); new Notice(`Indexed ${this.cardCount()} cards in ${this.index.size} notes.`); } });

    this.app.workspace.onLayoutReady(async () => {
      await this.fullIndex(true);
      this.registerEvent(this.app.metadataCache.on('changed', (file) => this.queueIndex(file)));
      this.registerEvent(this.app.vault.on('delete', (file) => { this.index.delete(file.path); this.refresh(); }));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));
    });
    this.registerInterval(window.setInterval(() => this.refresh(), 15 * 60 * 1000));
  }

  // ── persistence ──
  save() { clearTimeout(this._saveT); this._saveT = setTimeout(() => this.saveData({ settings: this.settings, state: this.state }), 800); }
  async onunload() { clearTimeout(this._saveT); await this.saveData({ settings: this.settings, state: this.state }); }

  // ── indexing ──
  isWatched(path) {
    if (!path.endsWith('.md')) return false;
    const folders = this.settings.watchedFolders.map((f) => normalizePath(f)).filter((f) => f && f !== '/');
    return !folders.length || folders.some((f) => path.startsWith(f + '/'));
  }
  isMoc(file) { return this.app.metadataCache.getFileCache(file)?.frontmatter?.type === 'moc' || / MOC$/.test(file.basename); }
  /** Slug of the nearest MOC folder above a path (a MOC's topic covers its folder and subfolders). */
  slugForPath(path) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { const s = this.folderSlug.get(parts.join('/')); if (s) return s; parts.pop(); }
    return null;
  }
  async fullIndex(startup) {
    this.index.clear(); this.mocs.clear(); this.folderSlug.clear();
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.isWatched(f.path));
    const firstRun = !Object.keys(this.state.known).length;
    for (const f of files) if (this.isMoc(f)) await this.indexMoc(f);
    const added = [];
    for (const f of files) {
      const n = await this.indexNote(f);
      if (n && !this.state.known[f.path]) { this.state.known[f.path] = firstRun ? '—' : today(); if (!firstRun) added.push(n); }
    }
    if (startup && added.length) new Notice(`📥 ${added.length} new note(s) joined your study queue: ${added.slice(0, 3).map((n) => n.basename).join(', ')}${added.length > 3 ? '…' : ''}`, 8000);
    this.save(); this.refresh();
  }
  queueIndex(file) {
    if (!(file instanceof TFile) || !this.isWatched(file.path)) return;
    this._pending = this._pending || new Map();
    clearTimeout(this._pending.get(file.path));
    this._pending.set(file.path, setTimeout(async () => {
      this._pending.delete(file.path);
      if (this.isMoc(file)) { await this.indexMoc(file); this.refresh(); return; }
      const before = this.index.get(file.path);
      const n = await this.indexNote(file);
      if (n && !this.state.known[file.path]) {
        this.state.known[file.path] = today();
        new Notice(`📥 “${n.basename}” added to ${this.topicName(n.slug)} — ${n.cards.length} card(s). It unlocks in n+1 order.`, 6000);
      } else if (n && before && n.cards.length > before.cards.length) {
        new Notice(`➕ ${n.cards.length - before.cards.length} new card(s) in “${n.basename}”`);
      }
      this.save(); this.refresh();
    }, 1500));
  }
  async indexMoc(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const tags = [].concat(fm.tags || []).map(String);
    const slug = tags.find((t) => t !== 'moc') || slugify(file.basename.replace(/ MOC$/, ''));
    const cache = this.app.metadataCache.getFileCache(file) || {};
    const heads = cache.headings || [];
    const hi = heads.findIndex((h) => /learning path/i.test(h.heading));
    const from = hi >= 0 ? heads[hi].position.start.line : 0;
    const to = hi >= 0 ? ((heads.slice(hi + 1).find((h) => h.level <= heads[hi].level) || {}).position?.start.line ?? Infinity) : Infinity;
    const order = new Map(); let i = 0;
    for (const l of cache.links || []) {
      const line = l.position.start.line;
      if (line < from || line >= to) continue;
      const base = l.link.split('#')[0].split('/').pop();
      if (!order.has(base)) order.set(base, i++);
    }
    this.mocs.set(slug, { name: file.basename.replace(/ MOC$/, ''), path: file.path, order, status: fm.status });
    this.folderSlug.set(file.parent ? file.parent.path : '', slug);
  }
  async indexNote(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    if (this.isMoc(file)) return null;
    const text = await this.app.vault.cachedRead(file);
    if (!text.includes('#flashcards') && !/^## Key ideas/m.test(text)) { this.index.delete(file.path); return null; }
    const parsed = parseNote(text);
    const tags = [].concat(fm.tags || []).map(String).filter((t) => t !== 'moc');
    const slug = parsed.deck || this.slugForPath(file.path) || tags[0] || slugify((file.parent && file.parent.name) || 'general') || 'general';
    const cards = parsed.cards.map((c) => ({ id: cardId(file.path, c.q), q: c.q, a: c.a, slug: c.deck && c.deck !== '*' ? c.deck : slug }));
    if (!cards.length && parsed.ideas.length < 2) { this.index.delete(file.path); return null; }
    const n = { path: file.path, basename: file.basename, slug, cards, ideas: parsed.ideas, summary: parsed.summary, links: parsed.links, hasFm: !!fm.type };
    this.index.set(file.path, n);
    return n;
  }
  onRename(file, oldPath) {
    if (this.state.known[oldPath]) { this.state.known[file.path] = this.state.known[oldPath]; delete this.state.known[oldPath]; }
    if (this.state.notes[oldPath]) { this.state.notes[file.path] = this.state.notes[oldPath]; delete this.state.notes[oldPath]; }
    const n = this.index.get(oldPath);
    if (n) for (const c of n.cards) {
      const st = this.state.cards[c.id];
      if (st) { const nid = cardId(file.path, c.q); this.state.cards[nid] = Object.assign({}, st, { p: file.path }); delete this.state.cards[c.id]; }
    }
    this.index.delete(oldPath);
    if (file instanceof TFile) this.queueIndex(file);
    this.save();
  }
  cardCount() { let n = 0; for (const x of this.index.values()) n += x.cards.length; return n; }

  // ── items & queries ──
  cardItem(n, c) { return { kind: 'card', key: 'c:' + c.id, id: c.id, notePath: n.path, slug: c.slug, q: c.q, a: c.a }; }
  explainItem(n) { return { kind: 'explain', key: 'e:' + n.path, notePath: n.path, slug: n.slug }; }
  stateOf(item) { return (item.kind === 'card' ? this.state.cards[item.id] : this.state.notes[item.notePath]) || {}; }
  notesOf(slug) {
    const moc = this.mocs.get(slug);
    const list = [...this.index.values()].filter((n) => n.slug === slug || n.cards.some((c) => c.slug === slug));
    const pos = (n) => (moc && moc.order.has(n.basename) ? moc.order.get(n.basename) : 1e6);
    return list.sort((a, b) => pos(a) - pos(b) || a.path.localeCompare(b.path));
  }
  dueItems(slugs) {
    const t = today(), out = [], set = new Set(slugs);
    for (const n of this.index.values()) {
      for (const c of n.cards) { const s = this.state.cards[c.id]; if (set.has(c.slug) && s && s.seen && s.due <= t) out.push(this.cardItem(n, c)); }
      const e = this.state.notes[n.path]; if (set.has(n.slug) && e && e.seen && e.due <= t) out.push(this.explainItem(n));
    }
    return out.sort((a, b) => String(this.stateOf(a).due).localeCompare(String(this.stateOf(b).due)));
  }
  interleave(items) {
    const by = new Map();
    for (const i of items) { if (!by.has(i.slug)) by.set(i.slug, []); by.get(i.slug).push(i); }
    const out = []; let more = true;
    while (more) { more = false; for (const l of by.values()) if (l.length) { out.push(l.shift()); more = true; } }
    return out;
  }
  /** The n+1 step for a topic: unseen cards of the first not-yet-learned note in MOC order (or its explain item). */
  frontier(slug) {
    for (const n of this.notesOf(slug)) {
      const cards = n.cards.filter((c) => c.slug === slug);
      const unseen = cards.filter((c) => !(this.state.cards[c.id] || {}).seen);
      if (unseen.length) return { note: n, items: unseen.map((c) => this.cardItem(n, c)) };
      const learning = cards.filter((c) => (this.state.cards[c.id] || {}).reps === 0);
      if (learning.length) return { note: n, locked: true, items: [] };
      if (n.slug === slug && n.ideas.length >= 2 && !(this.state.notes[n.path] || {}).seen) return { note: n, items: [this.explainItem(n)] };
    }
    return null;
  }
  itemsForNote(path) {
    const n = this.index.get(path); if (!n) return [];
    const items = n.cards.map((c) => this.cardItem(n, c));
    if (n.ideas.length >= 2) items.push(this.explainItem(n));
    return items;
  }
  topicName(slug) { return (this.mocs.get(slug) || {}).name || titleCase(slug || 'misc'); }
  topics() {
    const by = new Map();
    const t = today();
    for (const n of this.index.values()) for (const c of n.cards) {
      if (!by.has(c.slug)) by.set(c.slug, { slug: c.slug, name: this.topicName(c.slug), mocPath: (this.mocs.get(c.slug) || {}).path, total: 0, learned: 0, mature: 0, due: 0 });
      const x = by.get(c.slug), s = this.state.cards[c.id] || {};
      x.total++; if (s.reps > 0) x.learned++; if (s.ivl >= 21) x.mature++; if (s.seen && s.due <= t) x.due++;
    }
    for (const x of by.values()) {
      const f = this.frontier(x.slug);
      x.next = f ? { name: f.note.basename, locked: !!f.locked } : null;
    }
    return [...by.values()];
  }
  hintFor(item) {
    const n = this.index.get(item.notePath); if (!n || !n.ideas.length) return n && n.summary;
    let best = null, score = -1;
    for (const idea of n.ideas) { const o = overlap(idea, item.a) || 0; if (o > score) { score = o; best = idea; } }
    return best;
  }

  // ── grading side-effects ──
  async applyGrade(item, grade, xp, { sureWrong }) {
    const prev = this.stateOf(item);
    const next = schedule(prev, grade);
    if (item.kind === 'card') this.state.cards[item.id] = Object.assign(next, { p: item.notePath });
    else this.state.notes[item.notePath] = next;
    const d = this.day(); d.answered++; if (grade !== 'again') d.correct++; if (sureWrong) d.sureWrong++;
    await this.award(xp, item.slug);
    this.updateNoteStatus(item.notePath);
  }
  day() { const t = today(); return (this.state.days[t] = this.state.days[t] || { xp: 0, answered: 0, correct: 0, sureWrong: 0 }); }
  async award(xp, slug) {
    if (!xp) { this.save(); return; }
    const before = levelInfo(this.state.xp).level;
    const t = today(), st = this.state.streak;
    if (st.last !== t) { st.count = st.last === moment().subtract(1, 'days').format('YYYY-MM-DD') ? (st.count || 0) + 1 : 1; st.last = t; }
    this.state.xp += xp;
    this.state.topicXp[slug] = (this.state.topicXp[slug] || 0) + xp;
    this.day().xp += xp;
    const after = levelInfo(this.state.xp).level;
    if (after > before) new Notice(`⬆️ Level ${after} — ${levelTitle(after)}`, 6000);
    this.save();
  }
  async updateNoteStatus(path) {
    if (!this.settings.updateNoteStatus) return;
    const n = this.index.get(path); if (!n || !n.hasFm || !n.cards.length) return;
    const states = n.cards.map((c) => this.state.cards[c.id] || {});
    let status = null;
    if (states.every((s) => s.ivl >= 21)) status = 'evergreen';
    else if (states.every((s) => s.reps > 0)) status = 'growing';
    if (!status) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    const cur = this.app.metadataCache.getFileCache(file)?.frontmatter?.status;
    if (file instanceof TFile && cur !== status) await this.app.fileManager.processFrontMatter(file, (fm) => { fm.status = status; });
  }
  async appendExplanation(path, label, text) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !text.trim()) return;
    const block = [`> [!example]- ${today()} · ${label.replace(/\n/g, ' ').slice(0, 120)}`, ...text.trim().split('\n').map((l) => '> ' + l)].join('\n');
    await this.app.vault.process(file, (t) => {
      if (/^## My explanation\s*$/m.test(t)) return t.replace(/^## My explanation\s*$/m, `## My explanation\n${block}\n`);
      const section = `## My explanation\n${block}\n\n`;
      const at = [t.search(/^## Recall\s*$/m), t.search(/^> \[!quote\]-? Original notes/m)].find((i) => i >= 0);
      return at !== undefined ? t.slice(0, at) + section + t.slice(at) : t.replace(/\s*$/, '\n\n') + section;
    });
  }

  // ── topic selection (also flips the MOC status, so Bases views agree) ──
  async toggleTopic(slug, on) {
    const sel = new Set(this.state.selected);
    if (on && !sel.has(slug) && sel.size >= this.settings.maxActiveTopics) {
      new Notice(`Max ${this.settings.maxActiveTopics} topics at a time — depth beats breadth. Unselect one first.`);
      return this.refresh();
    }
    on ? sel.add(slug) : sel.delete(slug);
    this.state.selected = [...sel];
    const moc = this.mocs.get(slug);
    const f = moc && this.app.vault.getAbstractFileByPath(moc.path);
    if (this.settings.syncMocStatus && f instanceof TFile) await this.app.fileManager.processFrontMatter(f, (fm) => { fm.status = on ? 'active' : 'paused'; });
    this.save(); this.refresh();
  }

  // ── session & UI glue ──
  startSession(opts) {
    if (opts.mode !== 'note' && !(opts.slugs || []).length) return new Notice('Select at least one topic on the dashboard.');
    const s = new Session(this, opts);
    new SessionModal(this, s).open();
  }
  finishSession() { this.save(); this.refresh(); }
  async openDashboard() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
  refresh() {
    clearTimeout(this._refT);
    this._refT = setTimeout(() => {
      const lv = levelInfo(this.state.xp).level;
      const due = this.dueItems(this.topics().map((t) => t.slug)).length;
      if (this.status) this.status.setText(`🎓 Lv ${lv} · ${due} due`);
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof StudyView) leaf.view.render();
    }, 300);
  }
};

class StudyZoneSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.p = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    const s = this.p.settings, save = () => { this.p.save(); this.p.refresh(); };
    new Setting(containerEl).setName('Your context').setHeading();
    new Setting(containerEl).setName('My context').setDesc('Used by "adapt it to your context" prompts. Relating ideas to yourself is one of the strongest memory effects.')
      .addTextArea((t) => t.setValue(s.myContext).onChange((v) => { s.myContext = v; save(); }));
    new Setting(containerEl).setName('What gets studied').setHeading();
    new Setting(containerEl).setName('Watched folders').setDesc('One per line. Leave empty to watch the whole vault. New notes here join automatically.')
      .addTextArea((t) => t.setValue(s.watchedFolders.join('\n')).onChange((v) => { s.watchedFolders = v.split('\n').map((x) => x.trim()).filter(Boolean); save(); }))
      .addButton((b) => b.setButtonText('Re-index').onClick(() => this.p.fullIndex()));
    new Setting(containerEl).setName('Max topics at once').addSlider((x) => x.setLimits(1, 6, 1).setValue(s.maxActiveTopics).setDynamicTooltip().onChange((v) => { s.maxActiveTopics = v; save(); }));
    new Setting(containerEl).setName('Answers per session').setDesc('Short and frequent beats long and rare.').addSlider((x) => x.setLimits(5, 60, 5).setValue(s.sessionLength).setDynamicTooltip().onChange((v) => { s.sessionLength = v; save(); }));
    new Setting(containerEl).setName('New notes per session (n+1 steps)').addSlider((x) => x.setLimits(0, 5, 1).setValue(s.newNotesPerSession).setDynamicTooltip().onChange((v) => { s.newNotesPerSession = v; save(); }));
    new Setting(containerEl).setName('Daily XP goal').addSlider((x) => x.setLimits(20, 300, 10).setValue(s.dailyGoalXp).setDynamicTooltip().onChange((v) => { s.dailyGoalXp = v; save(); }));
    new Setting(containerEl).setName('Friction (desirable difficulty)').setHeading();
    new Setting(containerEl).setName('Minimum answer length').setDesc('Characters you must type before revealing.').addSlider((x) => x.setLimits(0, 60, 2).setValue(s.minAnswerChars).setDynamicTooltip().onChange((v) => { s.minAnswerChars = v; save(); }));
    new Setting(containerEl).setName('Ask confidence before reveal').addToggle((x) => x.setValue(s.requireConfidence).onChange((v) => { s.requireConfidence = v; save(); }));
    new Setting(containerEl).setName('Deep prompt every N correct answers').addSlider((x) => x.setLimits(1, 10, 1).setValue(s.deepEvery).setDynamicTooltip().onChange((v) => { s.deepEvery = v; save(); }));
    new Setting(containerEl).setName('Minimum deep answer length').addSlider((x) => x.setLimits(20, 300, 10).setValue(s.minDeepChars).setDynamicTooltip().onChange((v) => { s.minDeepChars = v; save(); }));
    new Setting(containerEl).setName('Save deep answers into the note').setDesc('Adds them under "## My explanation".').addToggle((x) => x.setValue(s.saveDeepAnswers).onChange((v) => { s.saveDeepAnswers = v; save(); }));
    new Setting(containerEl).setName('Writing to frontmatter').setHeading();
    new Setting(containerEl).setName('Sync topic MOC status').setDesc('When you select or unselect a topic, set status: active / paused in its MOC.').addToggle((x) => x.setValue(s.syncMocStatus).onChange((v) => { s.syncMocStatus = v; save(); }));
    new Setting(containerEl).setName('Update note status').setDesc('Set status: growing / evergreen in a note as all its cards are learned / mature (21d+).').addToggle((x) => x.setValue(s.updateNoteStatus).onChange((v) => { s.updateNoteStatus = v; save(); }));
  }
}

// exported for tests (ignored by Obsidian)
module.exports.__test = { splitCard, parseNote, schedule, levelInfo, levelTitle, zoneOf, overlap, cardId, Session };
