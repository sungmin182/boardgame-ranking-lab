/**
 * 보드게임 랭킹 랩
 *
 * 설계 요약
 *  - data/games.json 을 한 번 읽어 메모리에 올린다.
 *  - 점수 계산에 쓰는 지표는 전부 "백분위(0~1)"로 미리 변환해 둔다.
 *    평점 8.4, 투표수 6만 같은 서로 다른 단위를 가중합하려면 척도를 맞춰야 하고,
 *    백분위는 이상치(투표수 10만짜리 카탄 등)에 흔들리지 않는다.
 *  - 필터 → 점수 → 정렬 → 렌더 순서로 흐르고, 상태는 전부 URL과 localStorage에 남는다.
 */

const CONFIG = window.LZ_CONFIG ?? {};
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) {
    if (k != null) node.append(k);
  }
  return node;
};

/* ── 점수 축 정의 ─────────────────────────────────────────
 * value(game, m) 는 "클수록 좋다"는 방향으로 맞춘 원시값을 돌려준다.
 * 실제 점수 계산은 이 값들의 백분위에 가중치를 곱해 더한다. */
const AXES = [
  {
    key: 'rating',
    label: '긱 평점',
    note: 'BGG 베이즈 평점',
    value: (g) => g.bayes,
  },
  {
    key: 'margin',
    label: '유저 열기',
    note: '유저 평균 − 베이즈 평점. 평가 수가 적어 순위에 덜 반영된 게임',
    value: (g) => g.margin,
  },
  {
    key: 'votes',
    label: '인기도',
    note: '평가 수(로그). −로 두면 숨은 게임 발굴',
    value: (g) => (g.votes ? Math.log10(g.votes) : null),
  },
  {
    key: 'momentum',
    label: '상승세',
    note: '최근 30일 순위 상승률',
    value: (g) => g.delta?.[30]?.rankPct,
  },
  {
    key: 'fresh',
    label: '최신성',
    note: '출시 연도',
    value: (g) => g.year,
  },
  {
    key: 'light',
    label: '가벼움',
    note: '난이도가 낮을수록 높음. −로 두면 헤비겜 우선',
    value: (g) => (g.weight != null ? -g.weight : null),
  },
  {
    key: 'owned',
    label: '보유율',
    note: '실제로 소장한 사람 수',
    value: (g) => (g.owned ? Math.log10(g.owned) : null),
  },
];

/** BGG의 언어 의존도 투표 결과를 짧은 한국어로 바꾼다 */
const LANG_DEP = [
  [/no necessary in-game text/i, '텍스트 없음'],
  [/some necessary text/i, '약간의 텍스트'],
  [/moderate in-game text/i, '보통 (요약본 필요)'],
  [/extensive use of text/i, '텍스트 많음 (번역 필요)'],
  [/unplayable in another language/i, '번역 없이 불가'],
];

function langDepText(raw) {
  if (!raw) return '–';
  return LANG_DEP.find(([re]) => re.test(raw))?.[1] ?? raw;
}

const PRESETS = {
  '긱 기본': { rating: 100, margin: 0, votes: 0, momentum: 0, fresh: 0, light: 0, owned: 0 },
  '숨은 명작': { rating: 65, margin: 45, votes: -70, momentum: 10, fresh: 0, light: 0, owned: -25 },
  '요즘 뜨는': { rating: 30, margin: 15, votes: 0, momentum: 100, fresh: 35, light: 0, owned: 0 },
  '신작 헌터': { rating: 50, margin: 20, votes: -15, momentum: 40, fresh: 100, light: 0, owned: 0 },
  '가족·입문': { rating: 60, margin: 0, votes: 25, momentum: 0, fresh: 10, light: 85, owned: 30 },
  '헤비 전략': { rating: 80, margin: 15, votes: -10, momentum: 0, fresh: 5, light: -85, owned: 0 },
  '검증된 스테디': { rating: 70, margin: -10, votes: 55, momentum: 0, fresh: -25, light: 0, owned: 60 },
};

const DEFAULT_FILTERS = () => ({
  players: [],
  strictPlayers: false,
  weightMin: null,
  weightMax: null,
  timeMin: null,
  timeMax: null,
  timeByMax: true,
  yearMin: null,
  yearMax: null,
  rankMin: null,
  rankMax: null,
  votesMin: null,
  votesMax: null,
  mech: {},
  cat: {},
  risingOnly: false,
  noTextOnly: false,
  myListOnly: false,
  hideExcluded: true,
  q: '',
});

/** 한 번에 비교할 수 있는 게임 수 */
const COMPARE_MAX = 4;

const state = {
  data: null,
  weights: { ...PRESETS['긱 기본'] },
  filters: DEFAULT_FILTERS(),
  sort: { key: 'score', dir: -1 },
  flags: JSON.parse(localStorage.getItem('lz.flags') ?? '{}'),
  compare: [],
  rendered: 0,
  view: [],
};

/* ── 백분위 계산 ──────────────────────────────────────── */
function attachPercentiles(games) {
  for (const axis of AXES) {
    const pairs = [];
    for (const g of games) {
      const v = axis.value(g);
      if (v != null && Number.isFinite(v)) pairs.push([g, v]);
    }
    pairs.sort((a, b) => a[1] - b[1]);

    // 동점은 같은 백분위를 받아야 한다(평균 순위 방식)
    let i = 0;
    while (i < pairs.length) {
      let j = i;
      while (j + 1 < pairs.length && pairs[j + 1][1] === pairs[i][1]) j++;
      const p = pairs.length > 1 ? (i + j) / 2 / (pairs.length - 1) : 0.5;
      for (let k = i; k <= j; k++) {
        (pairs[k][0].p ??= {})[axis.key] = p;
      }
      i = j + 1;
    }
    // 값이 없는 게임은 중앙값으로 취급해 점수가 과하게 깎이지 않게 한다
    for (const g of games) {
      (g.p ??= {})[axis.key] ??= 0.5;
    }
  }
}

function rawScore(g) {
  let sum = 0;
  for (const axis of AXES) {
    const w = state.weights[axis.key] ?? 0;
    if (w) sum += (w / 100) * g.p[axis.key];
  }
  return sum;
}

/* ── 필터 ─────────────────────────────────────────────── */
function matches(g, f) {
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!(g.name?.toLowerCase().includes(q) || g.kor?.toLowerCase().includes(q))) return false;
  }

  if (f.players.length) {
    const pool = f.strictPlayers ? g.best ?? [] : [...(g.best ?? []), ...(g.recommended ?? [])];
    if (!f.players.some((p) => pool.includes(p))) return false;
  }

  if (f.weightMin != null && (g.weight == null || g.weight < f.weightMin)) return false;
  if (f.weightMax != null && (g.weight == null || g.weight > f.weightMax)) return false;

  const t = f.timeByMax ? g.maxTime : g.minTime;
  if (f.timeMin != null && (t == null || t < f.timeMin)) return false;
  if (f.timeMax != null && (t == null || t > f.timeMax)) return false;

  if (f.yearMin != null && (g.year == null || g.year < f.yearMin)) return false;
  if (f.yearMax != null && (g.year == null || g.year > f.yearMax)) return false;

  if (f.rankMin != null && g.rank < f.rankMin) return false;
  if (f.rankMax != null && g.rank > f.rankMax) return false;

  if (f.votesMin != null && g.votes < f.votesMin) return false;
  if (f.votesMax != null && g.votes > f.votesMax) return false;

  if (f.risingOnly && !(g.delta?.[30]?.rank > 0)) return false;
  if (f.noTextOnly && !/no necessary in-game text/i.test(g.langDep ?? '')) return false;

  const flag = state.flags[g.id];
  if (f.myListOnly && flag !== 'want' && flag !== 'own') return false;
  if (f.hideExcluded && flag === 'skip') return false;

  for (const [name, mode] of Object.entries(f.mech)) {
    const has = g.mechanics?.includes(name);
    if (mode === 'include' && !has) return false;
    if (mode === 'exclude' && has) return false;
  }
  for (const [name, mode] of Object.entries(f.cat)) {
    const has = g.categories?.includes(name);
    if (mode === 'include' && !has) return false;
    if (mode === 'exclude' && has) return false;
  }
  return true;
}

/* ── 정렬 키 ──────────────────────────────────────────── */
const SORT_VALUE = {
  score: (g) => g._score,
  rank: (g) => g.rank,
  name: (g) => g.kor ?? g.name ?? '',
  year: (g) => g.year,
  players: (g) => g.best?.[0] ?? g.minPlayers,
  weight: (g) => g.weight,
  time: (g) => g.maxTime,
  bayes: (g) => g.bayes,
  average: (g) => g.average,
  margin: (g) => g.margin,
  votes: (g) => g.votes,
  d30: (g) => g.delta?.[30]?.rank,
  d30pct: (g) => g.delta?.[30]?.rankPct,
  dvotes: (g) => g.delta?.[30]?.votes,
};

const COLUMNS = [
  { key: 'score', label: '점수' },
  { key: 'rank', label: '긱순위' },
  { key: 'name', label: '게임', left: true },
  { key: 'year', label: '연도' },
  { key: 'players', label: '추천인원' },
  { key: 'weight', label: '난이도' },
  { key: 'time', label: '시간' },
  { key: 'bayes', label: 'BGG' },
  { key: 'average', label: '유저평점' },
  { key: 'margin', label: '차이' },
  { key: 'votes', label: '평가수' },
  { key: 'd30', label: '30일 변동' },
  { key: 'dvotes', label: '평가 증가' },
];

function recompute() {
  const f = state.filters;
  const list = state.data.games.filter((g) => matches(g, f));
  for (const g of list) g._score = rawScore(g);

  // 화면에 보이는 0~100 점수는 현재 결과 집합 안에서 상대적으로 매긴다
  const scores = list.map((g) => g._score);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const span = hi - lo || 1;
  for (const g of list) g._score100 = Math.round(((g._score - lo) / span) * 1000) / 10;

  const get = SORT_VALUE[state.sort.key] ?? SORT_VALUE.score;
  const dir = state.sort.dir;
  list.sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // 값 없는 행은 항상 아래로
    if (bv == null) return -1;
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });

  state.view = list;
  state.rendered = 0;
  $('#tbody').replaceChildren();
  $('#resultCount').textContent = `${list.length.toLocaleString('ko-KR')}개`;
  $('#empty').hidden = list.length > 0;
  renderMore();
  syncUrl();
}

/* ── 렌더 ─────────────────────────────────────────────── */
const CHUNK = 80;
const fmt = (v, digits = 0) =>
  v == null ? '–' : v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function deltaCell(value, suffix = '') {
  if (value == null) return el('td', { textContent: '–' });
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : '';
  const sign = value > 0 ? '▲' : value < 0 ? '▼' : '–';
  return el('td', {
    className: cls,
    textContent: value === 0 ? '–' : `${sign} ${Math.abs(value).toLocaleString('ko-KR')}${suffix}`,
  });
}

function playersText(g) {
  const best = g.best ?? [];
  const rec = (g.recommended ?? []).filter((p) => !best.includes(p));
  const span = (arr) => {
    if (!arr.length) return null;
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    return min === max ? `${min}` : `${min}–${max}`;
  };
  const b = span(best);
  const r = span(rec);
  if (b && r) return `${b} (${r})`;
  if (b) return b;
  if (r) return `(${r})`;
  return g.minPlayers ? `${g.minPlayers}–${g.maxPlayers}` : '–';
}

function flagButton(g, type, glyph, title) {
  const btn = el('button', {
    className: `flag${state.flags[g.id] === type ? ' on' : ''}`,
    textContent: glyph,
    title,
  });
  btn.onclick = (e) => {
    e.stopPropagation();
    if (state.flags[g.id] === type) delete state.flags[g.id];
    else state.flags[g.id] = type;
    localStorage.setItem('lz.flags', JSON.stringify(state.flags));
    recompute();
  };
  return btn;
}

/** 행에 붙는 "비교 담기" 토글 */
function compareButton(g) {
  const on = state.compare.includes(g.id);
  const btn = el('button', {
    className: `flag compare-flag${on ? ' on' : ''}`,
    textContent: '⇄',
    title: on ? '비교에서 빼기' : '비교에 담기',
  });
  btn.onclick = (e) => {
    e.stopPropagation();
    toggleCompare(g.id);
  };
  return btn;
}

function toggleCompare(id) {
  const i = state.compare.indexOf(id);
  if (i >= 0) {
    state.compare.splice(i, 1);
  } else {
    if (state.compare.length >= COMPARE_MAX) {
      toast(`비교는 최대 ${COMPARE_MAX}개까지 담을 수 있습니다`);
      return;
    }
    state.compare.push(id);
  }
  refreshCompareUi();
}

function refreshCompareUi() {
  // 이미 그려진 행의 버튼 상태만 갱신한다(표 전체를 다시 그리면 스크롤이 튄다)
  for (const tr of document.querySelectorAll('#tbody tr')) {
    const on = state.compare.includes(Number(tr.dataset.id));
    const btn = tr.querySelector('.compare-flag');
    if (btn) {
      btn.classList.toggle('on', on);
      btn.title = on ? '비교에서 빼기' : '비교에 담기';
    }
  }
  renderCompareBar();
  if (!$('#compareView').hidden) {
    if (state.compare.length >= 2) openCompare();
    else $('#compareView').hidden = true;
  }
}

function renderCompareBar() {
  const bar = $('#compareBar');
  if (!state.compare.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const games = state.compare.map((id) => state.data.games.find((g) => g.id === id)).filter(Boolean);

  const chips = games.map((g) => {
    const chip = el('button', {
      className: 'compare-chip',
      title: '빼기',
    });
    chip.append(
      g.thumb ? el('img', { src: g.thumb, alt: '' }) : null,
      el('span', { textContent: g.kor ?? g.name ?? '' }),
      el('b', { textContent: '×' })
    );
    chip.onclick = () => toggleCompare(g.id);
    return chip;
  });

  const open = el('button', {
    className: 'preset-btn on',
    textContent: `${games.length}개 비교하기`,
  });
  open.onclick = openCompare;

  const clear = el('button', { className: 'ghost-btn', textContent: '비우기' });
  clear.onclick = () => {
    state.compare = [];
    refreshCompareUi();
  };

  bar.replaceChildren(el('span', { className: 'sub', textContent: '비교함' }), ...chips, open, clear);
  bar.hidden = false;
}

/* ── 비교 화면 ────────────────────────────────────────── */

/** 여러 게임의 순위 추이를 한 좌표계에 겹쳐 그린다 */
function compareSpark(games, colors) {
  const series = games.map((g) => {
    const pts = [];
    for (const off of [365, 30, 7]) {
      const d = g.delta?.[off];
      if (d?.rank != null) pts.push({ x: -off, rank: g.rank + d.rank });
    }
    pts.push({ x: 0, rank: g.rank });
    return pts;
  });
  const all = series.flat().map((p) => p.rank);
  if (all.length < 2) return null;

  const W = 700;
  const H = 150;
  const PAD = { l: 42, r: 10, t: 12, b: 20 };
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const px = (x) => PAD.l + ((x + 365) / 365) * (W - PAD.l - PAD.r);
  const py = (rank) => PAD.t + ((rank - lo) / span) * (H - PAD.t - PAD.b); // 순위는 작을수록 위

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'compare-spark');

  const parts = [
    `<line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H - PAD.b}" stroke="var(--border)"/>`,
    `<text x="${PAD.l - 6}" y="${PAD.t + 4}" font-size="10" text-anchor="end" fill="var(--text-dim)">${lo}위</text>`,
    `<text x="${PAD.l - 6}" y="${H - PAD.b}" font-size="10" text-anchor="end" fill="var(--text-dim)">${hi}위</text>`,
    `<text x="${PAD.l}" y="${H - 5}" font-size="10" fill="var(--text-dim)">1년 전</text>`,
    `<text x="${W - PAD.r}" y="${H - 5}" font-size="10" text-anchor="end" fill="var(--text-dim)">현재</text>`,
  ];

  series.forEach((pts, i) => {
    if (pts.length < 2) return;
    const d = pts
      .map((p, j) => `${j ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.rank).toFixed(1)}`)
      .join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${colors[i]}" stroke-width="2.5" stroke-linejoin="round"/>`);
    for (const p of pts) {
      parts.push(`<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.rank).toFixed(1)}" r="3.5" fill="${colors[i]}"/>`);
    }
  });

  svg.innerHTML = parts.join('');
  return svg;
}

/** 숫자 행에서 가장 좋은 값에 표시를 남긴다. better: 'high' | 'low' */
function bestIndexes(values, better) {
  const nums = values.filter((v) => v != null && Number.isFinite(v));
  if (nums.length < 2) return new Set();
  // 전부 같은 값이면 우열이 없으므로 아무것도 표시하지 않는다
  if (Math.min(...nums) === Math.max(...nums)) return new Set();
  const target = better === 'low' ? Math.min(...nums) : Math.max(...nums);
  const set = new Set();
  values.forEach((v, i) => {
    if (v === target) set.add(i);
  });
  return set;
}

function openCompare() {
  const games = state.compare.map((id) => state.data.games.find((g) => g.id === id)).filter(Boolean);
  const view = $('#compareView');
  if (games.length < 2) {
    toast('비교하려면 2개 이상 담아주세요');
    view.hidden = true;
    return;
  }

  const colors = ['#2f6f4e', '#b3402f', '#2f5f9e', '#8a6d1f'];

  const close = el('button', { className: 'close', textContent: '×', title: '닫기' });
  close.onclick = () => (view.hidden = true);

  // 헤더: 게임 카드
  const head = el('div', { className: 'compare-head' });
  games.forEach((g, i) => {
    const card = el(
      'div',
      { className: 'compare-card' },
      el('div', { className: 'swatch', style: `background:${colors[i]}` }),
      g.image ? el('img', { src: g.image, alt: '', loading: 'lazy' }) : null,
      el('b', { textContent: g.kor ?? g.name ?? '' }),
      el('small', { textContent: `${g.rank}위 · ${g.year ?? ''}` })
    );
    head.append(card);
  });

  // 스펙 비교표
  const ROWS = [
    { label: '내 점수', get: (g) => g._score100, fmt: (v) => v?.toFixed(1), better: 'high' },
    { label: 'BGG 순위', get: (g) => g.rank, fmt: (v) => `${v}위`, better: 'low' },
    { label: 'BGG 평점', get: (g) => g.bayes, fmt: (v) => v?.toFixed(2), better: 'high' },
    { label: '유저 평점', get: (g) => g.average, fmt: (v) => v?.toFixed(2), better: 'high' },
    { label: '평점 차이', get: (g) => g.margin, fmt: (v) => v?.toFixed(2), better: 'high' },
    { label: '평가 수', get: (g) => g.votes, fmt: (v) => fmt(v), better: 'high' },
    { label: '난이도', get: (g) => g.weight, fmt: (v) => `${v?.toFixed(2)} / 5`, better: null },
    { label: '추천 인원', get: () => null, text: (g) => playersText(g) },
    { label: '전체 인원', get: () => null, text: (g) => `${g.minPlayers}–${g.maxPlayers}명` },
    {
      label: '플레이 시간',
      get: (g) => g.maxTime,
      fmt: (v) => `${v}분`,
      text: (g) => (g.minTime === g.maxTime ? `${g.maxTime}분` : `${g.minTime}–${g.maxTime}분`),
      better: 'low',
    },
    { label: '연령', get: (g) => g.minAge, fmt: (v) => `${v}세+`, better: 'low' },
    { label: '언어 의존', get: () => null, text: (g) => langDepText(g.langDep) },
    { label: '보유자 수', get: (g) => g.owned, fmt: (v) => fmt(v), better: 'high' },
    { label: '위시리스트', get: (g) => g.wishing, fmt: (v) => fmt(v), better: 'high' },
    {
      label: '30일 순위 변동',
      get: (g) => g.delta?.[30]?.rank,
      fmt: (v) => (v > 0 ? `▲ ${v}` : v < 0 ? `▼ ${Math.abs(v)}` : '–'),
      better: 'high',
    },
    {
      label: '1년 순위 변동',
      get: (g) => g.delta?.[365]?.rank,
      fmt: (v) => (v > 0 ? `▲ ${v}` : v < 0 ? `▼ ${Math.abs(v)}` : '–'),
      better: 'high',
    },
  ];

  const table = el('table', { className: 'compare-table' });
  const tb = el('tbody');
  for (const row of ROWS) {
    const values = games.map(row.get);
    const best = row.better ? bestIndexes(values, row.better) : new Set();
    const tr = el('tr', {}, el('th', { textContent: row.label }));
    games.forEach((g, i) => {
      const text = row.text ? row.text(g) : values[i] == null ? '–' : row.fmt(values[i]);
      tr.append(el('td', { className: best.has(i) ? 'best' : '', textContent: text }));
    });
    tb.append(tr);
  }
  table.append(tb);

  // 공통점과 차이점
  const mechSets = games.map((g) => new Set(g.mechanics ?? []));
  const shared = [...(mechSets[0] ?? [])].filter((m) => mechSets.every((s) => s.has(m)));
  const uniqueBlocks = games.map((g, i) => {
    const own = (g.mechanics ?? []).filter((m) => !mechSets.some((s, j) => j !== i && s.has(m)));
    return el(
      'div',
      { className: 'compare-unique' },
      el('div', { className: 'sub' }, el('span', { className: 'dot', style: `background:${colors[i]}` }), ` ${g.kor ?? g.name} 에만 있는 메커니즘`),
      own.length
        ? el('div', { className: 'taglist' }, ...own.map((m) => el('span', { textContent: m })))
        : el('div', { className: 'sub', textContent: '없음' })
    );
  });

  view.replaceChildren(
    el('div', { className: 'compare-inner' },
      close,
      el('h2', { textContent: '게임 비교' }),
      head,
      el('div', { className: 'compare-scroll' }, table),
      el('h3', { textContent: '순위 추이 (최근 1년)' }),
      compareSpark(games, colors) ?? el('p', { className: 'sub', textContent: '비교할 순위 기록이 부족합니다.' }),
      el('h3', { textContent: '공통 메커니즘' }),
      shared.length
        ? el('div', { className: 'taglist' }, ...shared.map((m) => el('span', { textContent: m })))
        : el('p', { className: 'sub', textContent: '겹치는 메커니즘이 없습니다.' }),
      ...uniqueBlocks
    )
  );
  view.hidden = false;
}

function renderMore() {
  const tbody = $('#tbody');
  const slice = state.view.slice(state.rendered, state.rendered + CHUNK);
  const frag = document.createDocumentFragment();

  slice.forEach((g, i) => {
    const idx = state.rendered + i + 1;
    const tr = el('tr');
    tr.dataset.id = g.id;

    tr.append(
      el('td', {}, el('span', { className: 'score-pill', textContent: g._score100.toFixed(1) })),
      el('td', { textContent: g.rank ?? '–' }),
      el(
        'td',
        { className: 'left' },
        el(
          'div',
          { className: 'title-cell' },
          el('img', { src: g.thumb ?? '', alt: '', loading: 'lazy' }),
          el(
            'div',
            { className: 'title-main' },
            el('b', { textContent: g.kor ?? g.name ?? '' }),
            el('small', { textContent: g.kor ? g.name : g.desc ?? '' })
          ),
          el(
            'span',
            { className: 'row-actions' },
            flagButton(g, 'want', '★', '관심'),
            flagButton(g, 'own', '●', '보유'),
            flagButton(g, 'skip', '✕', '제외'),
            compareButton(g)
          )
        )
      ),
      el('td', { textContent: g.year ?? '–' }),
      el('td', { textContent: playersText(g) }),
      el('td', { textContent: g.weight != null ? g.weight.toFixed(2) : '–' }),
      el('td', { textContent: g.maxTime ? (g.minTime === g.maxTime ? `${g.maxTime}` : `${g.minTime}–${g.maxTime}`) : '–' }),
      el('td', { textContent: g.bayes != null ? g.bayes.toFixed(2) : '–' }),
      el('td', { textContent: g.average != null ? g.average.toFixed(2) : '–' }),
      el('td', { textContent: g.margin != null ? g.margin.toFixed(2) : '–' }),
      el('td', { textContent: fmt(g.votes) }),
      deltaCell(g.delta?.[30]?.rank),
      deltaCell(g.delta?.[30]?.votes)
    );

    tr.onclick = () => openDrawer(g);
    frag.append(tr);
    void idx;
  });

  tbody.append(frag);
  state.rendered += slice.length;
}

function renderHead() {
  const row = $('#headRow');
  row.replaceChildren(
    ...COLUMNS.map((c) => {
      const th = el('th', {
        textContent: c.label + (state.sort.key === c.key ? (state.sort.dir < 0 ? ' ▼' : ' ▲') : ''),
        className: `${c.left ? 'left ' : ''}${state.sort.key === c.key ? 'sorted' : ''}`,
      });
      th.onclick = () => {
        if (state.sort.key === c.key) state.sort.dir *= -1;
        else state.sort = { key: c.key, dir: c.key === 'name' ? 1 : -1 };
        renderHead();
        recompute();
      };
      return th;
    })
  );
}

/* ── 상세 서랍 ────────────────────────────────────────── */
function sparkline(g) {
  // 365 / 30 / 7일 전 순위와 현재 순위를 잇는 미니 그래프
  const pts = [];
  for (const off of [365, 30, 7]) {
    const d = g.delta?.[off];
    if (d?.rank != null) pts.push({ x: -off, rank: g.rank + d.rank });
  }
  pts.push({ x: 0, rank: g.rank });
  if (pts.length < 2) return null;

  const W = 380;
  const H = 56;
  const ranks = pts.map((p) => p.rank);
  const lo = Math.min(...ranks);
  const hi = Math.max(...ranks);
  const span = hi - lo || 1;
  const xs = pts.map((p) => ((p.x + 365) / 365) * (W - 8) + 4);
  // 순위는 작을수록 위
  const ys = pts.map((p) => ((p.rank - lo) / span) * (H - 16) + 8);
  const path = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'spark');
  svg.innerHTML =
    `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>` +
    xs.map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3" fill="var(--accent)"/>`).join('') +
    `<text x="4" y="${H - 1}" font-size="9" fill="var(--text-dim)">1년 전 ${pts[0].rank}위</text>` +
    `<text x="${W - 4}" y="${H - 1}" font-size="9" text-anchor="end" fill="var(--text-dim)">현재 ${g.rank}위</text>`;
  return svg;
}

function openDrawer(g) {
  const d = $('#drawer');
  d.hidden = false;
  document.querySelectorAll('#tbody tr.open').forEach((r) => r.classList.remove('open'));
  document.querySelector(`#tbody tr[data-id="${g.id}"]`)?.classList.add('open');

  const close = el('button', { className: 'close', textContent: '×', title: '닫기' });
  close.onclick = () => {
    d.hidden = true;
    document.querySelectorAll('#tbody tr.open').forEach((r) => r.classList.remove('open'));
  };

  const kv = el('dl', { className: 'kv' });
  const add = (k, v) => kv.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
  add('BGG 순위', `${g.rank}위`);
  add('점수', `${g._score100.toFixed(1)} / 100`);
  add('평점', `${g.bayes?.toFixed(2) ?? '–'} (유저 ${g.average?.toFixed(2) ?? '–'})`);
  add('평가 수', fmt(g.votes));
  add('난이도', `${g.weight?.toFixed(2) ?? '–'} / 5 (${fmt(g.weightVotes)}표)`);
  add('인원', `${g.minPlayers}–${g.maxPlayers}명 · 추천 ${playersText(g)}`);
  add('시간', g.maxTime ? `${g.minTime}–${g.maxTime}분` : '–');
  add('연령', g.minAge ? `${g.minAge}세+` : '–');
  add('언어 의존', langDepText(g.langDep));
  add('보유 / 위시', `${fmt(g.owned)} / ${fmt(g.wishing)}`);
  for (const off of [7, 30, 365]) {
    const dd = g.delta?.[off];
    if (dd?.rank != null) {
      add(`${off}일 변동`, `${dd.rank > 0 ? '▲' : dd.rank < 0 ? '▼' : '–'} ${Math.abs(dd.rank)}위 (평가 ${dd.votes > 0 ? '+' : ''}${fmt(dd.votes)})`);
    }
  }

  const tags = (title, arr) =>
    arr?.length
      ? el(
          'div',
          {},
          el('div', { className: 'sub', style: 'margin-top:10px' }, title),
          el('div', { className: 'taglist' }, ...arr.map((t) => el('span', { textContent: t })))
        )
      : null;

  const actions = el('div', { className: 'drawer-actions' });
  actions.append(
    el('a', {
      className: 'ghost-btn',
      href: `https://boardgamegeek.com${g.href ?? `/boardgame/${g.id}`}`,
      target: '_blank',
      rel: 'noopener',
      textContent: 'BGG에서 보기 ↗',
    }),
    el('a', {
      className: 'ghost-btn',
      href: `https://boardlife.co.kr/search?keyword=${encodeURIComponent(g.name ?? '')}`,
      target: '_blank',
      rel: 'noopener',
      textContent: '보드라이프 검색 ↗',
    })
  );

  const liveBox = el('div', { className: 'sub', style: 'margin-top:8px' });
  if (CONFIG.LIVE_PROXY) {
    const btn = el('button', { className: 'ghost-btn', textContent: '실시간 새로고침' });
    btn.onclick = async () => {
      btn.textContent = '조회 중…';
      try {
        const res = await fetch(`${CONFIG.LIVE_PROXY}/dynamicinfo?objectid=${g.id}`);
        const j = await res.json();
        const s = j.item?.stats ?? {};
        const rank = (j.item?.rankinfo ?? []).find((r) => r.rankobjectid === 1)?.rank;
        liveBox.textContent = `지금 이 순간: ${rank}위 · 평점 ${Number(s.baverage).toFixed(2)} · 평가 ${Number(s.usersrated).toLocaleString('ko-KR')}개`;
        btn.textContent = '실시간 새로고침';
      } catch {
        liveBox.textContent = '실시간 조회 실패 (프록시 주소를 확인하세요)';
        btn.textContent = '다시 시도';
      }
    };
    actions.append(btn);
  }

  d.replaceChildren(
    close,
    el('h3', { textContent: g.kor ?? g.name ?? '' }),
    el('div', { className: 'sub', textContent: `${g.kor ? g.name + ' · ' : ''}${g.year ?? ''}` }),
    g.image ? el('img', { className: 'cover', src: g.image, alt: '', loading: 'lazy' }) : null,
    g.desc ? el('p', { className: 'sub', textContent: g.desc }) : null,
    actions,
    liveBox,
    kv,
    sparkline(g),
    tags('메커니즘', g.mechanics),
    tags('카테고리', g.categories),
    tags('디자이너', g.designers),
    g.subranks?.length
      ? el(
          'div',
          {},
          el('div', { className: 'sub', style: 'margin-top:10px' }, '분야별 순위'),
          el('div', { className: 'taglist' }, ...g.subranks.map((s) => el('span', { textContent: `${s.name} ${s.rank}위` })))
        )
      : null
  );
}

/* ── UI 구성 ──────────────────────────────────────────── */
function buildSliders() {
  const box = $('#sliders');
  box.replaceChildren(
    ...AXES.map((axis) => {
      const val = el('span', { className: 'val', textContent: state.weights[axis.key] });
      const input = el('input', {
        type: 'range',
        min: -100,
        max: 100,
        step: 5,
        value: state.weights[axis.key],
      });
      input.dataset.axis = axis.key;
      input.oninput = () => {
        state.weights[axis.key] = Number(input.value);
        val.textContent = input.value;
        markPreset();
        recompute();
      };
      return el(
        'div',
        { className: 'slider' },
        el('label', { textContent: axis.label }),
        val,
        el('div', { className: 'note', textContent: axis.note }),
        input
      );
    })
  );
}

function syncSliders() {
  for (const input of document.querySelectorAll('#sliders input[type=range]')) {
    const key = input.dataset.axis;
    input.value = state.weights[key];
    input.parentElement.querySelector('.val').textContent = state.weights[key];
  }
}

function markPreset() {
  const current = JSON.stringify(state.weights);
  for (const btn of document.querySelectorAll('.preset-btn')) {
    btn.classList.toggle('on', JSON.stringify(PRESETS[btn.textContent]) === current);
  }
}

function buildPresets() {
  $('#presets').replaceChildren(
    ...Object.keys(PRESETS).map((name) => {
      const btn = el('button', { className: 'preset-btn', textContent: name });
      btn.onclick = () => {
        state.weights = { ...PRESETS[name] };
        syncSliders();
        markPreset();
        state.sort = { key: 'score', dir: -1 };
        renderHead();
        recompute();
      };
      return btn;
    })
  );
}

/** 숫자 범위 입력 두 개 */
function rangeInputs(container, minKey, maxKey, { min, max, step = 1, labelEl, unit = '' }) {
  const mk = (key, ph) => {
    const input = el('input', { type: 'number', placeholder: ph, min, max, step });
    if (state.filters[key] != null) input.value = state.filters[key];
    input.oninput = () => {
      state.filters[key] = input.value === '' ? null : Number(input.value);
      updateLabel();
      recompute();
    };
    return input;
  };
  const a = mk(minKey, String(min));
  const b = mk(maxKey, String(max));

  const updateLabel = () => {
    if (!labelEl) return;
    const lo = state.filters[minKey];
    const hi = state.filters[maxKey];
    labelEl.textContent =
      lo == null && hi == null ? '전체' : `${lo ?? min} – ${hi ?? max}${unit}`;
  };
  updateLabel();

  container.replaceChildren(a, el('span', { textContent: '~' }), b);
  container._sync = () => {
    a.value = state.filters[minKey] ?? '';
    b.value = state.filters[maxKey] ?? '';
    updateLabel();
  };
}

/** 값을 즉시 넣어주는 단축 칩 */
function quickChips(container, options, apply) {
  container.replaceChildren(
    ...options.map(({ label, values }) => {
      const btn = el('button', { className: 'chip', textContent: label });
      btn.onclick = () => {
        const active = btn.classList.contains('on');
        container.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        if (!active) btn.classList.add('on');
        apply(active ? null : values);
        recompute();
      };
      return btn;
    })
  );
}

function buildTagBox(box, facetList, bucket) {
  box.replaceChildren(
    ...facetList.slice(0, 90).map(({ name, count }) => {
      const tag = el('button', { className: 'tag', textContent: `${name} ${count}`, title: name });
      const paint = () => {
        tag.className = `tag ${state.filters[bucket][name] ?? ''}`.trim();
      };
      paint();
      tag.onclick = () => {
        // 클릭할 때마다 포함 → 제외 → 해제 순으로 돈다
        const cur = state.filters[bucket][name];
        if (!cur) state.filters[bucket][name] = 'include';
        else if (cur === 'include') state.filters[bucket][name] = 'exclude';
        else delete state.filters[bucket][name];
        paint();
        recompute();
      };
      return tag;
    })
  );
}

function buildFilters() {
  const f = state.filters;

  // 인원
  const chips = $('#playersChips');
  chips.replaceChildren(
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((p) => {
      const btn = el('button', { className: 'chip', textContent: `${p}인` });
      btn.onclick = () => {
        const i = f.players.indexOf(p);
        if (i >= 0) f.players.splice(i, 1);
        else f.players.push(p);
        btn.classList.toggle('on');
        $('#playersLabel').textContent = f.players.length
          ? f.players.sort((a, b) => a - b).join(', ') + '인'
          : '전체';
        recompute();
      };
      return btn;
    })
  );
  $('#strictPlayers').onchange = (e) => {
    f.strictPlayers = e.target.checked;
    recompute();
  };

  rangeInputs($('#weightRange'), 'weightMin', 'weightMax', {
    min: 1,
    max: 5,
    step: 0.1,
    labelEl: $('#weightLabel'),
  });
  quickChips(
    $('#weightChips'),
    [
      { label: '가벼움 ~2.0', values: [null, 2.0] },
      { label: '중간 2~3', values: [2.0, 3.0] },
      { label: '무거움 3~4', values: [3.0, 4.0] },
      { label: '아주 무거움 4+', values: [4.0, null] },
    ],
    (v) => {
      f.weightMin = v ? v[0] : null;
      f.weightMax = v ? v[1] : null;
      $('#weightRange')._sync();
    }
  );

  rangeInputs($('#timeRange'), 'timeMin', 'timeMax', {
    min: 5,
    max: 600,
    step: 5,
    labelEl: $('#timeLabel'),
    unit: '분',
  });
  $('#timeByMax').onchange = (e) => {
    f.timeByMax = e.target.checked;
    recompute();
  };

  const thisYear = new Date().getFullYear();
  rangeInputs($('#yearRange'), 'yearMin', 'yearMax', {
    min: 1950,
    max: thisYear,
    labelEl: $('#yearLabel'),
  });
  quickChips(
    $('#yearChips'),
    [
      { label: '3년 내', values: [thisYear - 3, null] },
      { label: '5년 내', values: [thisYear - 5, null] },
      { label: '10년 내', values: [thisYear - 10, null] },
      { label: '고전 ~2000', values: [null, 2000] },
    ],
    (v) => {
      f.yearMin = v ? v[0] : null;
      f.yearMax = v ? v[1] : null;
      $('#yearRange')._sync();
    }
  );

  rangeInputs($('#rankRange'), 'rankMin', 'rankMax', {
    min: 1,
    max: state.data.games.at(-1)?.rank ?? 1500,
    labelEl: $('#rankLabel'),
  });
  rangeInputs($('#votesRange'), 'votesMin', 'votesMax', {
    min: 0,
    max: 200000,
    step: 100,
    labelEl: $('#votesLabel'),
  });

  buildTagBox($('#mechBox'), state.data.facets.mechanics, 'mech');
  buildTagBox($('#catBox'), state.data.facets.categories, 'cat');

  for (const [id, key] of [
    ['risingOnly', 'risingOnly'],
    ['noTextOnly', 'noTextOnly'],
    ['myListOnly', 'myListOnly'],
    ['hideExcluded', 'hideExcluded'],
  ]) {
    const box = document.getElementById(id);
    box.checked = f[key];
    box.onchange = () => {
      f[key] = box.checked;
      recompute();
    };
  }
}

/* ── URL 상태 ─────────────────────────────────────────── */
function syncUrl() {
  const p = new URLSearchParams();
  const w = AXES.map((a) => state.weights[a.key]).join(',');
  if (w !== AXES.map((a) => PRESETS['긱 기본'][a.key]).join(',')) p.set('w', w);

  const f = state.filters;
  const def = DEFAULT_FILTERS();
  for (const [k, v] of Object.entries(f)) {
    if (k === 'mech' || k === 'cat') {
      const s = Object.entries(v)
        .map(([n, m]) => (m === 'exclude' ? '!' : '') + n)
        .join('|');
      if (s) p.set(k, s);
    } else if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(','));
    } else if (v !== def[k] && v != null && v !== '') {
      p.set(k, String(v));
    }
  }
  if (state.sort.key !== 'score' || state.sort.dir !== -1) {
    p.set('sort', `${state.sort.key}:${state.sort.dir}`);
  }
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

function loadUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has('w')) {
    const vals = p.get('w').split(',').map(Number);
    AXES.forEach((a, i) => {
      if (Number.isFinite(vals[i])) state.weights[a.key] = vals[i];
    });
  }
  const f = state.filters;
  for (const [k, raw] of p.entries()) {
    if (k === 'w' || k === 'sort') continue;
    if (k === 'mech' || k === 'cat') {
      for (const item of raw.split('|')) {
        if (!item) continue;
        const ex = item.startsWith('!');
        f[k][ex ? item.slice(1) : item] = ex ? 'exclude' : 'include';
      }
    } else if (k === 'players') {
      f.players = raw.split(',').map(Number).filter(Boolean);
    } else if (typeof f[k] === 'boolean') {
      f[k] = raw === 'true';
    } else if (k in f) {
      f[k] = raw === '' ? null : Number.isNaN(Number(raw)) ? raw : Number(raw);
    }
  }
  if (p.has('sort')) {
    const [key, dir] = p.get('sort').split(':');
    if (SORT_VALUE[key]) state.sort = { key, dir: Number(dir) || -1 };
  }
}

/* ── 기타 액션 ────────────────────────────────────────── */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), 1800);
}

function exportCsv() {
  const head = ['순위', '점수', '이름', '한글명', '연도', '난이도', '최소인원', '최대인원', '추천인원', '최소시간', '최대시간', 'BGG평점', '유저평점', '평가수', '30일변동'];
  const rows = state.view.map((g) => [
    g.rank,
    g._score100,
    g.name,
    g.kor ?? '',
    g.year,
    g.weight,
    g.minPlayers,
    g.maxPlayers,
    (g.best ?? []).join(' '),
    g.minTime,
    g.maxTime,
    g.bayes,
    g.average,
    g.votes,
    g.delta?.[30]?.rank ?? '',
  ]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: `boardgames-${state.data.date}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function initTheme() {
  const saved = localStorage.getItem('lz.theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeToggle').onclick = () => {
    const isDark =
      document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('lz.theme', next);
  };
}

/* ── 시작 ─────────────────────────────────────────────── */
async function main() {
  initTheme();

  const res = await fetch(CONFIG.DATA_URL ?? 'data/games.json');
  if (!res.ok) {
    $('#stamp').textContent = 'data/games.json 을 불러오지 못했습니다. npm run sync 를 먼저 실행하세요.';
    return;
  }
  state.data = await res.json();
  attachPercentiles(state.data.games);

  loadUrl();

  $('#stamp').textContent = `BGG ${state.data.date} 기준 · 상위 ${state.data.count.toLocaleString('ko-KR')}개`;

  buildPresets();
  buildSliders();
  buildFilters();
  renderHead();
  markPreset();

  // URL로 들어온 필터 값을 UI에 반영
  $('#search').value = state.filters.q;
  state.filters.players.forEach((p) => {
    $('#playersChips').children[p - 1]?.classList.add('on');
  });
  $('#strictPlayers').checked = state.filters.strictPlayers;
  $('#timeByMax').checked = state.filters.timeByMax;

  let searchTimer;
  $('#search').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      recompute();
    }, 160);
  };

  $('#tableWrap').onscroll = (e) => {
    const box = e.target;
    if (box.scrollTop + box.clientHeight > box.scrollHeight - 400) renderMore();
  };

  $('#compactMode').onchange = (e) => document.body.classList.toggle('compact', e.target.checked);
  $('#copyLink').onclick = async () => {
    await navigator.clipboard.writeText(location.href);
    toast('현재 필터·가중치가 담긴 링크를 복사했습니다');
  };
  $('#exportCsv').onclick = exportCsv;
  $('#resetFilters').onclick = () => {
    state.filters = DEFAULT_FILTERS();
    buildFilters();
    $('#search').value = '';
    recompute();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#compareView').hidden) $('#compareView').hidden = true;
      else $('#drawer').hidden = true;
    }
    if (e.key === '/' && document.activeElement !== $('#search')) {
      e.preventDefault();
      $('#search').focus();
    }
  });

  recompute();
}

main();
