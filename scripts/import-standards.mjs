// 성취기준 CSV 를 data/standards.json 으로 바꾼다.
//
// 왜 CSV 인가
//   성취기준은 NCIC(ncic.re.kr)이 엑셀로 공개하지만, 그 사이트는 robots.txt 가
//   Disallow: / 라 자동으로 받아올 수 없다. 사람이 내려받은 뒤 엑셀에서
//   "다른 이름으로 저장 → CSV UTF-8" 로 바꿔 두면 이 스크립트가 읽는다.
//   XLSX 를 직접 읽으려면 외부 라이브러리가 필요한데, 이 프로젝트는 빌드 도구
//   없이 도는 것이 원칙이라 CSV 로 받는다.
//
//   실행: node scripts/import-standards.mjs <csv경로> [교과명]
//
// 열 이름은 자료마다 다르므로 찾아서 맞춘다. 못 찾으면 무엇이 있었는지 알려준다.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCsv, readJson, writeJson } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'standards.json');

/** 열 이름 후보. 자료마다 표기가 달라서 넉넉히 잡는다. */
const COLUMNS = {
  code: ['성취기준코드', '코드', '성취기준 코드', '기준코드'],
  text: ['성취기준', '성취기준내용', '내용', '성취기준 내용'],
  subject: ['교과', '교과목', '과목', '교과명'],
  area: ['영역', '영역명', '내용영역', '핵심아이디어'],
  grade: ['학년', '학년군', '학년(군)', '대상'],
};

/** 헤더에서 원하는 열을 찾는다. 정확히 같은 이름을 먼저, 없으면 포함하는 것을 쓴다. */
function pickColumn(headers, candidates) {
  for (const c of candidates) {
    const exact = headers.find((h) => h.replace(/\s/g, '') === c.replace(/\s/g, ''));
    if (exact) return exact;
  }
  for (const c of candidates) {
    const loose = headers.find((h) => h.replace(/\s/g, '').includes(c.replace(/\s/g, '')));
    if (loose) return loose;
  }
  return null;
}

/**
 * 성취기준 코드에서 학년군과 교과를 뽑는다.
 *   [4수01-01] → 학년군 3~4, 교과기호 수, 영역번호 01
 * 초등 성취기준은 학년군(1~2, 3~4, 5~6) 단위라 "4학년 2학기"로 딱 나뉘지 않는다.
 * 학기 구분은 교과서 단원 배열을 따르므로 여기서는 학년군까지만 본다.
 */
const SUBJECT_BY_MARK = {
  국: '국어', 수: '수학', 사: '사회', 과: '과학', 도: '도덕',
  체: '체육', 음: '음악', 미: '미술', 영: '영어', 실: '실과',
  통: '통합교과', 창: '창의적 체험활동',
};

const GRADE_BAND = { 2: '1~2학년', 4: '3~4학년', 6: '5~6학년' };

function parseCode(raw) {
  const m = String(raw ?? '').match(/\[?\s*(\d)([가-힣])(\d{2})\s*-\s*(\d{2})\s*\]?/);
  if (!m) return null;
  const [, band, mark, area, no] = m;
  return {
    code: `${band}${mark}${area}-${no}`,
    band: GRADE_BAND[Number(band)] ?? `${band}학년`,
    subject: SUBJECT_BY_MARK[mark] ?? mark,
    areaNo: area,
  };
}

export async function importStandards(csvPath, subjectHint = null) {
  const text = await fs.readFile(csvPath, 'utf8');
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!rows.length) throw new Error('CSV 에 행이 없습니다.');

  const headers = Object.keys(rows[0]);
  const col = Object.fromEntries(
    Object.entries(COLUMNS).map(([k, cands]) => [k, pickColumn(headers, cands)])
  );

  if (!col.text && !col.code) {
    throw new Error(
      `성취기준 코드나 내용 열을 찾지 못했습니다.\n  이 파일의 열: ${headers.join(' | ')}\n` +
        '  scripts/import-standards.mjs 의 COLUMNS 에 열 이름을 추가하세요.'
    );
  }

  const seen = new Set();
  const standards = [];

  for (const row of rows) {
    const rawCode = col.code ? row[col.code] : '';
    const rawText = col.text ? row[col.text] : '';
    // 코드가 따로 없으면 성취기준 문장 앞에 붙어 있는 경우가 많다
    const parsed = parseCode(rawCode) ?? parseCode(rawText);
    if (!parsed) continue;
    if (seen.has(parsed.code)) continue;
    seen.add(parsed.code);

    // 문장 앞의 [4수01-01] 표기는 떼어낸다
    const body = String(rawText ?? '')
      .replace(/\[?\s*\d[가-힣]\d{2}\s*-\s*\d{2}\s*\]?/, '')
      .trim();

    standards.push({
      code: parsed.code,
      band: parsed.band,
      subject: (col.subject ? row[col.subject] : null) || subjectHint || parsed.subject,
      area: (col.area ? row[col.area] : '') || '',
      text: body,
    });
  }

  if (!standards.length) {
    throw new Error(
      '성취기준 코드를 하나도 찾지 못했습니다. 코드가 [4수01-01] 형태인지 확인하세요.\n' +
        `  읽은 행: ${rows.length}개 · 열: ${headers.join(' | ')}`
    );
  }

  // 이미 있는 것과 합친다(교과별로 여러 번 넣을 수 있게)
  const prev = (await readJson(OUT, {}))?.standards ?? [];
  const merged = new Map(prev.map((s) => [s.code, s]));
  for (const s of standards) merged.set(s.code, s);
  const all = [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));

  await writeJson(OUT, {
    _주석: [
      '성취기준 목록. scripts/import-standards.mjs 가 CSV 에서 만들어 넣습니다.',
      '출처: 국가교육과정정보센터(ncic.re.kr) 교육과정 자료실 — 교육부 고시 자료입니다.',
      '초등 성취기준은 학년군(1~2, 3~4, 5~6) 단위라 학기로 나뉘지 않습니다.',
    ],
    updatedAt: new Date().toISOString(),
    count: all.length,
    standards: all,
  });

  const bySubject = {};
  for (const s of all) bySubject[s.subject] = (bySubject[s.subject] ?? 0) + 1;
  console.log(`[standards] ${standards.length}개 읽음 → 전체 ${all.length}개 저장`);
  console.log('[standards] 교과별:', Object.entries(bySubject).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log('[standards] 예시:', all.slice(0, 3).map((s) => `[${s.code}] ${s.text.slice(0, 30)}…`).join(' / '));
  return all;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [csv, subject] = process.argv.slice(2);
  if (!csv) {
    console.error('사용법: node scripts/import-standards.mjs <csv경로> [교과명]');
    process.exit(1);
  }
  await importStandards(csv, subject);
}
