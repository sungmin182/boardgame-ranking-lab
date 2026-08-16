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
    const hit =
      g.name?.toLowerCase().includes(q) ||
      g.kor?.toLowerCase().includes(q) ||
      g.korAlt?.some((n) => n.toLowerCase().includes(q));
    if (!hit) return false;
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
  renderExcludedNote();
  syncUrl();
}

/* ── 렌더 ─────────────────────────────────────────────── */
const CHUNK = 80;
const fmt = (v, digits = 0) =>
  v == null ? '–' : v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function deltaCell(value, suffix = '') {
  if (value == null || value === 0) {
    return el('td', {}, el('span', { className: 'delta flat', textContent: '–' }));
  }
  const cls = value > 0 ? 'up' : 'down';
  const sign = value > 0 ? '▲' : '▼';
  return el(
    'td',
    {},
    el('span', {
      className: `delta ${cls}`,
      textContent: `${sign} ${Math.abs(value).toLocaleString('ko-KR')}${suffix}`,
    })
  );
}

/** 점수를 5단계 순차 램프로 나눈다(색 하나를 밝기로만 구분). */
function scorePill(score) {
  const tier = score >= 92 ? 5 : score >= 78 ? 4 : score >= 58 ? 3 : score >= 34 ? 2 : 1;
  return el('span', { className: `score-pill t${tier}`, textContent: score.toFixed(1) });
}

/** 난이도 1~5를 다섯 칸 미터로 보여준다. 숫자만으로는 눈에 안 들어온다. */
function weightCell(weight) {
  if (weight == null) return el('td', { textContent: '–' });
  const meter = el('div', { className: 'weight-meter' });
  for (let i = 1; i <= 5; i++) {
    meter.append(el('i', { className: i <= Math.round(weight) ? 'f' : '' }));
  }
  return el(
    'td',
    {},
    el('span', { className: 'weight-cell' }, meter, el('span', { textContent: weight.toFixed(2) }))
  );
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

function saveFlags() {
  localStorage.setItem('lz.flags', JSON.stringify(state.flags));
}

function flagButton(g, type, glyph, title) {
  const btn = el('button', {
    className: `flag${state.flags[g.id] === type ? ' on' : ''}`,
    textContent: glyph,
    title,
  });
  btn.onclick = async (e) => {
    e.stopPropagation();
    const already = state.flags[g.id] === type;

    // 제외는 목록에서 사라져 되돌리기 어려우므로 한 번 확인한다.
    // 해제(이미 제외된 것을 다시 누르는 경우)는 물어보지 않는다.
    if (!already && type === 'skip') {
      const ok = await confirmDialog({
        title: '이 게임을 제외할까요?',
        body: `「${g.kor ?? g.name}」이(가) 목록에서 숨겨집니다. 데이터가 지워지는 것은 아니며, 언제든 다시 되돌릴 수 있습니다.`,
        confirmText: '제외하기',
        danger: true,
      });
      if (!ok) return;
    }

    if (already) delete state.flags[g.id];
    else state.flags[g.id] = type;
    saveFlags();
    recompute();

    if (!already && type === 'skip') {
      toast(`「${g.kor ?? g.name}」을(를) 제외했습니다`, {
        label: '실행 취소',
        action: () => {
          delete state.flags[g.id];
          saveFlags();
          recompute();
        },
      });
    }
  };
  return btn;
}

/* ── 확인 창 ──────────────────────────────────────────── */
function confirmDialog({ title, body, confirmText = '확인', cancelText = '취소', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#modal');

    const done = (value) => {
      modal.hidden = true;
      modal.replaceChildren();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };

    const cancel = el('button', { className: 'ghost-btn', textContent: cancelText });
    cancel.onclick = () => done(false);

    const ok = el('button', {
      className: `solid-btn${danger ? ' danger' : ''}`,
      textContent: confirmText,
    });
    ok.onclick = () => done(true);

    modal.replaceChildren(
      el(
        'div',
        { className: 'modal-card', role: 'alertdialog', 'aria-modal': 'true' },
        el('h3', { textContent: title }),
        el('p', { textContent: body }),
        el('div', { className: 'modal-actions' }, cancel, ok)
      )
    );
    modal.hidden = false;
    // 바깥을 눌러도 닫히게 한다
    modal.onclick = (e) => {
      if (e.target === modal) done(false);
    };
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}

/* ── 제외 목록 관리 ───────────────────────────────────── */
function renderExcludedNote() {
  const box = $('#excludedNote');
  const ids = Object.entries(state.flags)
    .filter(([, v]) => v === 'skip')
    .map(([id]) => Number(id));

  if (!ids.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  const show = el('button', { className: 'link-btn', textContent: '보기' });
  show.onclick = () => {
    $('#hideExcluded').checked = false;
    state.filters.hideExcluded = false;
    state.filters.q = '';
    $('#search').value = '';
    recompute();
    toast('제외한 게임이 목록에 다시 표시됩니다. ✕를 눌러 해제하세요');
  };

  const clear = el('button', { className: 'link-btn', textContent: '모두 해제' });
  clear.onclick = async () => {
    const names = ids
      .map((id) => state.data.games.find((g) => g.id === id))
      .filter(Boolean)
      .map((g) => g.kor ?? g.name);
    const okay = await confirmDialog({
      title: `제외 표시 ${ids.length}개를 모두 해제할까요?`,
      body: names.slice(0, 8).join(', ') + (names.length > 8 ? ` 외 ${names.length - 8}개` : ''),
      confirmText: '모두 해제',
    });
    if (!okay) return;
    for (const id of ids) delete state.flags[id];
    saveFlags();
    recompute();
    toast(`${ids.length}개를 되돌렸습니다`);
  };

  box.replaceChildren(
    el('span', { textContent: `제외한 게임 ${ids.length}개` }),
    show,
    el('span', { className: 'dot-sep', textContent: '·' }),
    clear
  );
  box.hidden = false;
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

  // 계열색은 CSS 토큰에서 읽는다. 라이트/다크 각각 dataviz 검증을 통과한 값이라
  // 테마가 바뀌면 그에 맞는 단계가 자동으로 적용된다.
  const css = getComputedStyle(document.documentElement);
  const colors = [1, 2, 3, 4].map((i) => css.getPropertyValue(`--series-${i}`).trim() || '#666');

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
      el('td', {}, scorePill(g._score100)),
      el('td', {
        className: `rank-cell${g.rank <= 3 ? ` m${g.rank}` : ''}`,
        textContent: g.rank ?? '–',
      }),
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
      weightCell(g.weight),
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

/* ── BGG 리뷰 ─────────────────────────────────────────────
 * 클릭했을 때만 불러온다. 표에 3000개를 미리 담아두지 않는 이유는
 * 남의 사이트 글을 통째로 복사해 두지 않기 위해서다. 화면에는 앞부분만
 * 보여주고, 전체는 원문 링크로 넘긴다. */
const REVIEW_COUNT = 10;
const REVIEW_MIN_LEN = 80;
/** 워커의 TRANSLATE_MAX 와 같은 값. 번역이 잘렸는지 화면에서 알려주는 데 쓴다. */
const TRANSLATE_LIMIT = 2000;
const reviewCache = new Map();
/** 번역 결과는 원문을 키로 기억해 둔다. 같은 리뷰를 다시 열어도 재요청하지 않는다. */
const translationCache = new Map();

const wantsKorean = () => localStorage.getItem('lz.translate') !== 'off';

/** 리뷰 본문을 번역문/원문 사이로 바꾸고, 접힘 여부를 다시 판정한다 */
function paintReviewBodies(box, translated) {
  for (const article of box.querySelectorAll('.review')) {
    const body = article.querySelector('.review-body');
    const ko = article.dataset.ko;
    const en = article.dataset.en;
    const useKo = translated && ko;
    body.textContent = useKo ? ko : en;
    article.classList.toggle('is-translated', Boolean(useKo));
    updateReviewClamp(article);
  }
}

/**
 * 접힌 상태에서 넘치는 글에만 '더 보기'를 보여준다.
 * 번역문과 원문은 길이가 달라서, 전환할 때마다 다시 재어야 한다.
 */
function updateReviewClamp(article) {
  const body = article.querySelector('.review-body');
  const more = article.querySelector('.review-more');
  if (!more) return;

  const expanded = article.classList.contains('expanded');
  if (expanded) {
    more.hidden = false;
    more.textContent = '접기';
    article.classList.remove('is-clamped');
  } else {
    // 접힌 높이보다 실제 내용이 길면 넘친다
    const overflows = body.scrollHeight - body.clientHeight > 4;
    more.hidden = !overflows;
    more.textContent = '더 보기';
    // 흐림 처리와 버튼은 항상 같이 간다. 흐린데 버튼이 없으면 막힌 것처럼 보인다.
    article.classList.toggle('is-clamped', overflows);
  }

  // 번역은 앞부분까지만 한다. 펼쳤는데도 원문보다 짧으면 그 사실을 알려준다.
  const note = article.querySelector('.review-note');
  if (note) {
    const cut =
      article.classList.contains('is-translated') && article.dataset.en.length > TRANSLATE_LIMIT;
    note.hidden = !(expanded && cut);
  }
}

async function translateReviews(box, texts) {
  const need = texts.filter((t) => !translationCache.has(t));
  if (need.length) {
    const res = await fetch(`${CONFIG.LIVE_PROXY}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: need }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { translated } = await res.json();
    need.forEach((t, i) => translationCache.set(t, translated?.[i] ?? ''));
  }
  return texts.map((t) => translationCache.get(t) ?? '');
}

async function loadReviews(g, box) {
  if (!CONFIG.LIVE_PROXY) return;

  box.replaceChildren(el('p', { className: 'sub', textContent: '리뷰를 불러오는 중…' }));
  try {
    let items = reviewCache.get(g.id);
    if (!items) {
      const res = await fetch(`${CONFIG.LIVE_PROXY}/comments?objectid=${g.id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      items = (json.items ?? [])
        .map((i) => ({
          user: i.user?.username ?? '(알 수 없음)',
          country: i.user?.country ?? '',
          rating: Number(i.rating),
          text: (i.textfield?.comment?.value ?? '').trim(),
        }))
        .filter((r) => r.text);
      reviewCache.set(g.id, items);
    }

    // "충실한 것"의 기준. 길이순으로만 뽑으면 초장문만 올라와 전부 잘린 채로 보인다.
    // 200~1200자 구간을 가장 높게 치고, 그보다 긴 글은 점수를 조금씩 깎는다.
    const score = (r) => {
      const n = r.text.length;
      if (n < REVIEW_MIN_LEN) return -1;
      return n <= 1200 ? n : 1200 - (n - 1200) * 0.15;
    };
    const picked = items
      .filter((r) => r.text.length >= REVIEW_MIN_LEN)
      .sort((a, b) => score(b) - score(a))
      .slice(0, REVIEW_COUNT);

    const list = picked.length ? picked : items.slice(0, REVIEW_COUNT);

    if (!list.length) {
      box.replaceChildren(el('p', { className: 'sub', textContent: '등록된 리뷰가 없습니다.' }));
      return;
    }

    const status = el('p', {
      className: 'sub',
      textContent: `평가 ${items.length}개 중 내용이 있는 ${list.length}개 · BGG 이용자가 쓴 글입니다`,
    });

    const toggle = el('button', { className: 'link-btn', type: 'button' });
    const articles = list.map((r) => {
      const a = el(
        'article',
        { className: 'review' },
        el(
          'div',
          { className: 'review-head' },
          el('span', {
            className: `review-score ${r.rating >= 8 ? 'high' : r.rating >= 6 ? 'mid' : 'low'}`,
            textContent: Number.isFinite(r.rating) ? r.rating.toFixed(1) : '–',
          }),
          el('span', { className: 'review-user', textContent: r.user }),
          r.country ? el('span', { className: 'review-country', textContent: r.country }) : null
        ),
        el('p', { className: 'review-body', textContent: r.text })
      );
      a.dataset.en = r.text;

      const more = el('button', { className: 'review-more', type: 'button', hidden: true });
      more.onclick = () => {
        a.classList.toggle('expanded');
        updateReviewClamp(a);
      };
      const note = el('p', {
        className: 'review-note',
        hidden: true,
        textContent: `번역은 앞 ${TRANSLATE_LIMIT.toLocaleString('ko-KR')}자까지입니다. 나머지는 '원문 보기'나 BGG에서 확인하세요.`,
      });
      a.append(more, note);
      return a;
    });

    box.replaceChildren(
      el('div', { className: 'review-bar' }, status, toggle),
      ...articles,
      el('a', {
        className: 'ghost-btn',
        href: `https://boardgamegeek.com/boardgame/${g.id}/ratings?rated=1&comment=1`,
        target: '_blank',
        rel: 'noopener',
        textContent: 'BGG에서 전체 리뷰 보기 ↗',
      })
    );

    let showKo = wantsKorean();
    let busy = false;

    const paintToggle = () => {
      toggle.textContent = showKo ? '원문 보기' : '한국어로 보기';
      toggle.disabled = busy;
    };

    const ensureTranslation = async () => {
      if (articles.every((a) => a.dataset.ko)) return true;
      busy = true;
      status.textContent = '한국어로 옮기는 중…';
      paintToggle();
      try {
        const ko = await translateReviews(box, articles.map((a) => a.dataset.en));
        articles.forEach((a, i) => {
          if (ko[i]) a.dataset.ko = ko[i];
        });
        return true;
      } catch {
        status.textContent = '번역에 실패했습니다. 원문을 표시합니다.';
        return false;
      } finally {
        busy = false;
      }
    };

    const render = async () => {
      if (showKo) {
        const ok = await ensureTranslation();
        if (!ok) showKo = false;
        else {
          status.textContent =
            `평가 ${items.length}개 중 내용이 있는 ${list.length}개 · 기계 번역이라 어색할 수 있습니다`;
        }
      } else {
        status.textContent = `평가 ${items.length}개 중 내용이 있는 ${list.length}개 · BGG 이용자가 쓴 글입니다`;
      }
      paintReviewBodies(box, showKo);
      paintToggle();
      // 웹폰트가 늦게 실리면 줄 높이가 달라진다. 폰트가 준비된 뒤 한 번 더 잰다.
      document.fonts?.ready.then(() => {
        box.querySelectorAll('.review').forEach(updateReviewClamp);
      });
    };

    toggle.onclick = () => {
      if (busy) return;
      showKo = !showKo;
      localStorage.setItem('lz.translate', showKo ? 'on' : 'off');
      render();
    };

    paintToggle();
    render();
  } catch {
    box.replaceChildren(
      el('p', { className: 'sub', textContent: '리뷰를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' })
    );
  }
}

/* ── 서랍 폭 조절 ─────────────────────────────────────────
 * 왼쪽 모서리를 잡아끌어 넓힐 수 있다. 리뷰처럼 긴 글은 좁은 패널에서
 * 읽기 나쁘기 때문이다. 정한 폭은 기억하고, 더블클릭하면 기본으로 돌아간다. */
const DRAWER_MIN = 340;
const DRAWER_DEFAULT = 450;
const drawerMax = () => Math.min(window.innerWidth - 80, 1100);

function setDrawerWidth(px, save = true) {
  const w = Math.round(Math.max(DRAWER_MIN, Math.min(px, drawerMax())));
  document.documentElement.style.setProperty('--drawer-w', `${w}px`);
  if (save) localStorage.setItem('lz.drawerWidth', String(w));
}

function initDrawerResize() {
  const saved = Number(localStorage.getItem('lz.drawerWidth'));
  setDrawerWidth(Number.isFinite(saved) && saved > 0 ? saved : DRAWER_DEFAULT, false);

  // 창을 줄였을 때 서랍이 화면 밖으로 나가지 않게 한다
  addEventListener('resize', () => {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--drawer-w'), 10);
    if (Number.isFinite(cur)) setDrawerWidth(cur, false);
  });
}

function drawerResizer() {
  const handle = el('div', {
    className: 'drawer-resizer',
    title: '좌우로 끌어 폭 조절 (더블클릭하면 기본값)',
  });

  handle.onpointerdown = (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');

    const move = (ev) => setDrawerWidth(window.innerWidth - ev.clientX, false);
    const up = (ev) => {
      handle.releasePointerCapture(ev.pointerId);
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      setDrawerWidth(window.innerWidth - ev.clientX); // 여기서만 저장한다
      // 폭이 바뀌면 줄 수가 달라지므로 '더 보기' 표시를 다시 판정한다
      document.querySelectorAll('#drawer .review').forEach(updateReviewClamp);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  handle.ondblclick = () => {
    setDrawerWidth(DRAWER_DEFAULT);
    document.querySelectorAll('#drawer .review').forEach(updateReviewClamp);
  };

  return handle;
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
      // 보드라이프 검색은 search.php?query=...&page=game 형태다.
      // 국내 사이트이므로 한글명이 있으면 그쪽으로 찾는 편이 잘 걸린다.
      href: `https://boardlife.co.kr/search.php?query=${encodeURIComponent(
        g.kor ?? g.name ?? ''
      )}&page=game`,
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

  const reviewBox = el('div', { className: 'reviews' });
  const reviewSection = CONFIG.LIVE_PROXY
    ? el(
        'section',
        { className: 'review-section' },
        el('h4', { textContent: 'BGG 리뷰' }),
        reviewBox
      )
    : null;

  d.replaceChildren(
    drawerResizer(),
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
      : null,
    reviewSection
  );

  if (CONFIG.LIVE_PROXY) loadReviews(g, reviewBox);
}

/* ── UI 구성 ──────────────────────────────────────────── */
function buildSliders() {
  const box = $('#sliders');
  box.replaceChildren(
    ...AXES.map((axis) => {
      const val = el('span', { className: 'val' });
      const paintVal = (v) => {
        val.textContent = v > 0 ? `+${v}` : String(v);
        val.className = `val ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}`.trim();
      };
      paintVal(state.weights[axis.key]);

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
        paintVal(Number(input.value));
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
    const v = state.weights[key];
    input.value = v;
    const val = input.parentElement.querySelector('.val');
    val.textContent = v > 0 ? `+${v}` : String(v);
    val.className = `val ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}`.trim();
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

/** 필터·가중치·정렬·검색을 처음 상태로 되돌린다 */
function goHome() {
  state.filters = DEFAULT_FILTERS();
  state.weights = { ...PRESETS['긱 기본'] };
  state.sort = { key: 'score', dir: -1 };
  state.compare = [];

  $('#drawer').hidden = true;
  $('#compareView').hidden = true;
  $('#search').value = '';
  $('#compactMode').checked = false;
  document.body.classList.remove('compact');

  buildFilters();
  syncSliders();
  markPreset();
  renderHead();
  refreshCompareUi();
  recompute();

  $('#tableWrap').scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toast(msg, undo = null) {
  const t = $('#toast');
  t.replaceChildren(el('span', { textContent: msg }));

  if (undo) {
    const btn = el('button', { className: 'toast-action', textContent: undo.label });
    btn.onclick = () => {
      clearTimeout(toast._timer);
      t.hidden = true;
      undo.action();
    };
    t.append(btn);
  }

  t.hidden = false;
  clearTimeout(toast._timer);
  // 실행 취소 버튼이 있으면 누를 시간을 넉넉히 준다
  toast._timer = setTimeout(() => (t.hidden = true), undo ? 7000 : 2200);
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

/* ── 화면 모드 ────────────────────────────────────────────
 * 시스템 → 라이트 → 다크 순으로 도는 3단계. 예전에는 라이트/다크만
 * 오갔는데, 그러면 한번 누른 뒤로는 기기 설정을 다시 따라갈 수 없었다. */
const THEMES = [
  { key: 'system', label: '시스템', icon: '◐' },
  { key: 'light', label: '라이트', icon: '☀' },
  { key: 'dark', label: '다크', icon: '☾' },
];

function applyTheme(key) {
  if (key === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = key;

  const t = THEMES.find((x) => x.key === key) ?? THEMES[0];
  const btn = $('#themeToggle');
  if (btn) {
    btn.querySelector('.theme-icon').textContent = t.icon;
    btn.querySelector('.theme-label').textContent = t.label;
    btn.title = `화면 모드: ${t.label} (눌러서 전환)`;
    btn.setAttribute('aria-label', btn.title);
  }
}

function initTheme() {
  const saved = localStorage.getItem('lz.theme');
  let current = THEMES.some((t) => t.key === saved) ? saved : 'system';
  applyTheme(current);

  $('#themeToggle').onclick = () => {
    const i = THEMES.findIndex((t) => t.key === current);
    current = THEMES[(i + 1) % THEMES.length].key;
    localStorage.setItem('lz.theme', current);
    applyTheme(current);
  };
}

/* ── 시작 ─────────────────────────────────────────────── */
async function main() {
  initTheme();
  initDrawerResize();

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

  // 로고 = 처음 화면. 새로고침 대신 상태만 되돌려 즉시 반응하게 한다.
  // 관심·보유·제외 목록은 내가 만든 자료이므로 건드리지 않는다.
  $('#homeLink').onclick = (e) => {
    // 새 탭으로 열기(ctrl/cmd/가운데 버튼)는 그대로 둔다
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    goHome();
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
