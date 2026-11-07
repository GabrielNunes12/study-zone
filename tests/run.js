const assert = require('assert');
const Module = require('module');
const path = require('path');
process.env.NODE_PATH = path.join(__dirname, 'stub', 'node_modules'); Module._initPaths();
const ob = require('obsidian');
const Plugin = require('../main.js');
const T = Plugin.__test;
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('✓', name); };

const NOTES = {
  'Kafka/Kafka MOC.md': '---\ntype: moc\ntags:\n  - moc\n  - kafka\n---\n## Learning path\n1. [[Topics]]\n2. [[Partitions]]\n',
  'Kafka/Partitions.md': '---\ntype: concept\n---\n## Key ideas\n- Partitions let consumers read in parallel.\n- Order holds only within a partition.\n## Recall\n#flashcards/kafka\nWhy partitions?::Parallel consumers.\nWhere is order guaranteed?::Within one partition.\n',
  'Kafka/Topics.md': '---\ntype: concept\n---\n## Recall\n#flashcards/kafka\nWhat is a topic?::A named log of events.\n`String::valueOf` is?::A Java method reference\n',
  'Misc/Loose.md': 'Some text\n#flashcards\nPlain deck card?::Uses the folder name.\n',
};
function fakeApp() {
  const files = Object.keys(NOTES).map((p) => new ob.TFile(p));
  const cache = (f) => {
    const t = NOTES[f.path]; const fm = {};
    const m = t.match(/^---\n([\s\S]*?)\n---/);
    if (m) { let key; for (const l of m[1].split('\n')) { const kv = l.match(/^(\w+):\s*(.*)$/); if (kv) { key = kv[1]; fm[key] = kv[2] || []; } else if (/^\s+-/.test(l)) fm[key].push(l.replace(/^\s+-\s*/, '')); } }
    const headings = [], links = [];
    t.split('\n').forEach((l, i) => { const h = l.match(/^(#+)\s+(.*)/); if (h) headings.push({ heading: h[2], level: h[1].length, position: { start: { line: i } } });
      for (const x of l.matchAll(/\[\[([^\]|]+)/g)) links.push({ link: x[1], position: { start: { line: i } } }); });
    return { frontmatter: m ? fm : undefined, headings, links };
  };
  return { vault: { getMarkdownFiles: () => files, cachedRead: async (f) => NOTES[f.path], getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: cache }, workspace: { getLeavesOfType: () => [] } };
}
async function freshPlugin() {
  const p = new Plugin(fakeApp());
  p.settings = { watchedFolders: [], maxActiveTopics: 3, sessionLength: 20, newNotesPerSession: 2, minAnswerChars: 12, minDeepChars: 60,
    requireConfidence: true, deepEvery: 3, dailyGoalXp: 60, saveDeepAnswers: false, myContext: '', syncMocStatus: false, updateNoteStatus: false };
  p.state = { cards: {}, notes: {}, xp: 0, topicXp: {}, selected: [], streak: { last: null, count: 0 }, days: {}, known: {} };
  p.index = new Map(); p.mocs = new Map(); p.folderSlug = new Map(); p.saveData = async () => {}; p.status = null;
  await p.fullIndex(false);
  return p;
}

(async () => {
  await test('splitCard ignores :: inside inline code', () => {
    assert.deepStrictEqual(T.splitCard('Why?::Because'), { q: 'Why?', a: 'Because' });
    assert.deepStrictEqual(T.splitCard('`a::b` does?::Method ref'), { q: '`a::b` does?', a: 'Method ref' });
    assert.strictEqual(T.splitCard('plain prose'), null);
    assert.strictEqual(T.splitCard('# heading::x'), null);
  });
  await test('parseNote reads cards only below a deck tag and skips callouts', () => {
    const p = T.parseNote('Intro::not a card\n> quote::no\n#flashcards/x\nQ1::A1\n```\nin::code\n```\n');
    assert.deepStrictEqual(p.cards.map((c) => c.q), ['Q1']);
    assert.strictEqual(p.deck, 'x');
  });
  await test('scheduler expands intervals and resets on a lapse', () => {
    let s = {}; const seq = [];
    for (const g of ['good', 'good', 'good', 'again', 'good']) { s = T.schedule(s, g, false); seq.push(s.ivl); }
    assert.deepStrictEqual(seq, [1, 3, 8, 0, 1]);
    assert.ok(T.schedule({}, 'easy', false).ivl > T.schedule({}, 'good', false).ivl);
  });
  await test('zone controller follows the 85% rule', () => {
    assert.strictEqual(T.zoneOf([1, 1, 1, 1, 1, 1, 1, 1]).key, 'easy');
    assert.strictEqual(T.zoneOf([1, 1, 1, 0, 1, 1, 1, 0]).key, 'zone');
    assert.strictEqual(T.zoneOf([0, 0, 1, 0, 1, 0, 0, 1]).key, 'hard');
    assert.strictEqual(T.zoneOf([1, 1]).key, 'warm');
  });
  await test('levels: Shu-Ha-Ri titles and growing thresholds', () => {
    assert.strictEqual(T.levelInfo(0).level, 1);
    assert.strictEqual(T.levelInfo(100).level, 2);
    assert.strictEqual(T.levelTitle(12), 'Ha · Adapter');
  });
  await test('indexing: MOC topic, plain #flashcards uses folder name', async () => {
    const p = await freshPlugin();
    const topics = Object.fromEntries(p.topics().map((t) => [t.slug, t.total]));
    assert.deepStrictEqual(topics, { kafka: 4, misc: 1 });
    assert.strictEqual(p.topicName('kafka'), 'Kafka');
  });
  await test('n+1: notes unlock in MOC order, gated on the previous note', async () => {
    const p = await freshPlugin();
    assert.strictEqual(p.frontier('kafka').note.basename, 'Topics');
    const s = new T.Session(p, { slugs: ['kafka'], mode: 'topics' });
    const first = s.next(); assert.strictEqual(p.index.get(first.notePath).basename, 'Topics');
    // fail one card of "Topics" -> next note stays locked
    await p.applyGrade(first, 'again', 0, {}); s.record(first, 'again', {}); s.afterGrade();
    const second = s.queue.find((i) => i.notePath === first.notePath && i.key !== first.key);
    await p.applyGrade(second, 'good', 0, {});
    assert.ok(p.frontier('kafka').locked, 'Partitions must stay locked while a Topics card is still failing');
    await p.applyGrade(first, 'good', 0, {});
    assert.strictEqual(p.frontier('kafka').note.basename, 'Partitions');
  });
  await test('XP rewards desirable difficulty (Hard > Good > Easy) and calibration', async () => {
    const p = await freshPlugin();
    const s = new T.Session(p, { slugs: ['kafka'], mode: 'topics' });
    const it = s.next();
    const xp = (g, c) => s.record(Object.assign({}, it), g, { confidence: c }).xp;
    assert.ok(xp('hard') > xp('good') && xp('good') > xp('easy'));
    assert.strictEqual(xp('good', 'sure') - xp('good'), 3);
    assert.ok(s.record(Object.assign({}, it), 'again', { confidence: 'sure' }).sureWrong);
  });
  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
