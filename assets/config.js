/**
 * 사이트 설정.
 *
 * LIVE_PROXY
 *   BGG의 JSON 엔드포인트(api.geekdo.com)는 CORS 헤더를 주지 않기 때문에
 *   브라우저에서 직접 호출하면 차단됩니다. 그래서 "지금 이 순간 값"을 보려면
 *   아주 얇은 중계 서버가 하나 필요합니다.
 *
 *   proxy/worker.js 를 Cloudflare Workers에 배포한 뒤(무료, 1분 소요)
 *   발급된 주소를 여기에 넣으세요. 예:
 *     LIVE_PROXY: 'https://bgg-live.내계정.workers.dev'
 *
 *   비워두면 사이트는 매일 갱신되는 data/games.json 만으로 정상 동작하고,
 *   상세 패널의 '실시간 새로고침' 버튼만 숨겨집니다.
 */
window.LZ_CONFIG = {
  LIVE_PROXY: 'https://bgg-live-proxy.boardgame-ranking-lab.workers.dev',
  DATA_URL: 'data/games.json',

  /**
   * 상세 패널의 바깥 사이트 검색 버튼 주소.
   *
   * {q} 자리에 게임 이름(한글명이 있으면 한글명)이 들어갑니다.
   *
   * ── 왜 여기 모아 두었나 ─────────────────────────────
   * 이 사이트들은 robots.txt 로 자동 접근을 막고 있어서, 개발 중에 실제 주소를
   * 열어 확인할 수가 없습니다. 그래서 형식이 바뀌거나 처음부터 틀렸을 때
   * 코드를 고치지 않고 여기 한 줄만 고칠 수 있게 모았습니다.
   *
   * ── 고치는 방법 ────────────────────────────────────
   * 그 사이트에서 검색을 한 번 하고, 주소창의 주소를 그대로 붙여넣은 뒤
   * 검색어 부분만 {q} 로 바꾸면 됩니다.
   *
   * mobile 을 따로 둘 수 있습니다. PC 주소가 휴대폰에서 다른 주소로 넘어가면서
   * 검색어가 떨어져 나가는 경우가 있기 때문입니다(디시인사이드가 그렇습니다).
   * 비워두면 PC 주소를 그대로 씁니다.
   */
  LINKS: {
    boardlife: {
      label: '보드라이프 검색',
      url: 'https://boardlife.co.kr/search.php?query={q}&page=game',
    },

    bumagall: {
      label: '부마갤 검색',
      // 디시인사이드 부루마불 마이너 갤러리. 제목+본문 검색.
      url: 'https://gall.dcinside.com/mgallery/board/lists?id=bulemarble&s_type=search_subject_memo&s_keyword={q}',
      // 모바일은 도메인도 파라미터도 다르다. PC 주소로 들어가면 m.dcinside.com 으로
      // 넘어가면서 검색어가 통째로 떨어져 나가 갤러리 첫 화면만 열렸다.
      //   PC     s_type=search_subject_memo & s_keyword=
      //   모바일  s_type=subject_m          & serval=      (소문자다)
      mobile: 'https://m.dcinside.com/board/bulemarble?s_type=subject_m&serval={q}',
    },

    daangn: {
      label: '당근 검색',
      /*
       * 실제 검색 주소는 이런 모양입니다:
       *   /kr/buy-sell/s/?in=<동네>-<번호>&search=<검색어>
       *
       * in(동네)은 일부러 넣지 않습니다. 이 파일은 공개 저장소에 올라가므로
       * 사는 동네가 그대로 드러나기 때문입니다. 빼도 당근이 로그인된 계정의
       * 기본 동네로 알아서 잡아 줍니다.
       *
       * 특정 동네로 고정하고 싶다면 아래에 &in=... 을 덧붙이면 되지만,
       * 그 상태로 커밋하면 동네가 공개된다는 점을 기억하세요.
       */
      url: 'https://www.daangn.com/kr/buy-sell/s/?search={q}',
      mobile: '',

      /*
       * 휴대폰에서 누르면 게임 이름을 복사해 둡니다.
       *
       * 당근 앱이 어떤 주소를 받는지 실제로 재봤더니, /articles/... 같은 개별 글
       * 주소만 앱으로 열리고 검색·첫 화면 주소는 전부 웹으로 떨어졌습니다
       * (assets/deeplink-test.html 로 확인). 앱 고유 스킴은 공개돼 있지 않습니다.
       * 그래서 앱 검색까지 바로 가는 길은 없고, 이름만 복사해 두어 앱에서
       * 붙여넣게 합니다.
       */
      copyName: true,

      // 안드로이드에서 앱을 여는 데 쓰는 패키지명(당근이 공개한 assetlinks.json 의 값).
      // 지금은 검색 주소를 앱이 안 받아 쓰이지 않지만, 나중에 열리게 되면 되살린다.
      androidPackage: 'com.towneers.www',
      // iOS 는 앱 고유 스킴이 있어야 앱이 열린다. 공개된 곳에서 확인하지 못했다.
      // 당근 앱에서 "공유"로 나오는 주소를 보고 채우면 그때부터 쓰인다.
      //   예) 'karrotmarket://search?query={q}'
      iosScheme: '',
    },
  },
};
