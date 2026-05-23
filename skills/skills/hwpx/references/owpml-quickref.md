# OWPML 주요 요소 빠른 참조

KS X 6101 OWPML 스펙에서 실무 작업 시 가장 자주 만나는 요소들. 전체 스펙은 KS X 6101 PDF 또는 `hancom-io/hwpx-owpml-model` C++ 소스 참조.

각 예제는 네임스페이스 선언을 생략한다. 실제 파일에는 `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"` 등이 루트에 선언되어 있다.

## 섹션 / 단락 / 런

### `<hp:sec>` — 섹션

한 `section*.xml` 파일 = 한 섹션. 페이지 설정(여백, 용지)과 단락 흐름을 담는다.

```xml
<hp:sec>
  <hp:pagePr landscape="NARROWLY" width="59528" height="84188"
             gutterType="LEFT_ONLY">
    <hp:margin header="4252" footer="4252" gutter="0"
               left="8504" right="8504" top="5668" bottom="4252"/>
  </hp:pagePr>
  <hp:p paraPrIDRef="0" styleIDRef="0"> ... </hp:p>
</hp:sec>
```

단위: **HWP 단위(HU)**. 1mm ≈ 283.46 HU. A4 여백 30mm ≈ 8504 HU, 20mm ≈ 5668 HU, 15mm ≈ 4252 HU.

### `<hp:p>` — 단락

```xml
<hp:p paraPrIDRef="0" styleIDRef="0">
  <hp:run charPrIDRef="0">
    <hp:t>텍스트</hp:t>
  </hp:run>
</hp:p>
```

`paraPrIDRef` = header.xml의 `hh:paraPr` ID 참조 (정수).
`styleIDRef` = header.xml의 `hh:style` ID 참조.

### `<hp:run>` — 런 (문자 속성 단위)

```xml
<hp:run charPrIDRef="1">
  <hp:t>굵은 글씨</hp:t>
</hp:run>
```

한 단락 안에서 서식이 바뀌면 런이 분리된다.

### `<hp:t>` — 텍스트 leaf

```xml
<hp:t>실제 내용</hp:t>
```

**이 요소의 text가 실제 표시되는 문자열**. 치환·검색은 여기서 이루어진다.

### 특수 문자·제어

```xml
<hp:lineBreak/>      <!-- 줄바꿈 (Shift+Enter) -->
<hp:tab/>            <!-- 탭 -->
<hp:nbSpace/>        <!-- 줄바꿈 금지 공백 -->
<hp:hyphen/>         <!-- 하이픈 -->
```

## 표

```xml
<hp:tbl rowCnt="2" colCnt="3">
  <hp:sz width="43000" height="6000"/>
  <hp:tr>
    <hp:tc>
      <hp:subList>
        <hp:p paraPrIDRef="0">
          <hp:run charPrIDRef="0">
            <hp:t>셀1</hp:t>
          </hp:run>
        </hp:p>
      </hp:subList>
      <hp:cellAddr colAddr="0" rowAddr="0"/>
      <hp:cellSpan colSpan="1" rowSpan="1"/>
    </hp:tc>
    <!-- 다음 tc ... -->
  </hp:tr>
  <!-- 다음 tr ... -->
</hp:tbl>
```

- `<hp:tc>` 셀 내용은 **`<hp:subList>` 안의 `<hp:p>`**에 들어간다 (일반 단락과 동일 모델)
- 셀 병합은 `<hp:cellSpan>`의 `colSpan`/`rowSpan`
- 표 자체 크기는 `<hp:sz>`

## 이미지

```xml
<hp:pic binaryItemIDRef="image1">
  <hp:sz width="90000" height="60000"/>
  <hp:pos treatAsChar="0" affectLSpacing="0">
    <hp:offset x="0" y="0"/>
  </hp:pos>
</hp:pic>
```

`binaryItemIDRef`는 `content.hpf`의 `<opf:manifest>` 항목 ID와 매칭되어야 하고, 해당 manifest 항목의 `href`가 `BinData/N.ext` 실제 파일을 가리킨다.

## 하이퍼링크 / 북마크 / 필드

```xml
<hp:hyperlink href="https://…">
  <hp:run charPrIDRef="0">
    <hp:t>링크 텍스트</hp:t>
  </hp:run>
</hp:hyperlink>

<hp:fieldBegin type="HYPERLINK" name="…"/>
  <hp:run>…</hp:run>
<hp:fieldEnd/>

<hp:bookmark name="여기"/>
```

날짜·페이지 번호 같은 동적 필드도 `<hp:fieldBegin type="DATE|PAGE_NUMBER|…"/>` 형태.

## 헤더 / 푸터

```xml
<hh:header>
  <hh:subList>
    <hp:p> ... </hp:p>
  </hh:subList>
</hh:header>

<hh:footer>
  <hh:subList>
    <hp:p>
      <hp:run>
        <hp:fieldBegin type="PAGE_NUMBER"/>
        <hp:t>/</hp:t>
        <hp:fieldBegin type="TOTAL_PAGE_NUMBER"/>
      </hp:run>
    </hp:p>
  </hh:subList>
</hh:footer>
```

odd/even/first 변형이 가능. 상세는 header.xml의 `<hh:masterPage>`.

## 스타일 딕셔너리 (header.xml)

### `<hh:charPr>` — 문자 속성

```xml
<hh:charPr id="0" height="3000" textColor="#000000"
           letterSpacing="0" useFontSpace="0" useKerning="0">
  <hh:fontRef hangul="0" latin="1" hanja="0" japanese="0"
              other="0" symbol="0" user="0"/>
  <hh:ratio hangul="100" latin="100" hanja="100" japanese="100"
            other="100" symbol="100" user="100"/>
  <hh:spacing .../>
  <hh:relSz .../>
  <hh:offset .../>
  <hh:underline type="NONE" shape="SOLID" color="#000000"/>
</hh:charPr>
```

- `height` 단위는 **1/100 pt** — 3000 = 30pt? 실제로는 1/100 pt가 아니라 *점*의 1/100 (즉 11pt → 1100). **라이브러리 통해 설정할 것** — 수작업 시 기존 값 카피 권장.
- `<hh:fontRef>`는 **7언어 폰트 ID**를 각각 지정 (fontFace 테이블 인덱스).

### `<hh:paraPr>` — 단락 속성

```xml
<hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0"
           snapToGrid="1" suppressLineNumbers="0" checked="0">
  <hh:align horizontal="JUSTIFY" vertical="BASELINE"/>
  <hh:heading type="NONE" idRef="0" level="0"/>
  <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD"
                   widowOrphan="0" keepWithNext="0" keepLines="0"
                   pageBreakBefore="0" lineWrap="BREAK"/>
  <hh:margin>
    <hc:intent value="0"/>
    <hc:left value="0"/>
    <hc:right value="0"/>
    <hc:prev value="0"/>
    <hc:next value="0"/>
  </hh:margin>
  <hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>
  <!-- … -->
</hh:paraPr>
```

**줄간격 160%는 `<hh:lineSpacing type="PERCENT" value="160">`**.

### `<hh:style>` — 스타일 (정의된 형식)

```xml
<hh:style id="0" type="PARA" name="바탕글" engName="Normal"
          paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"
          langID="1042" lockForm="0"/>
```

`type="PARA"` 또는 `type="CHAR"`.

### `<hh:fontFace>` — 폰트 테이블

```xml
<hh:fontFaces lang="HANGUL" fontCnt="3">
  <hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0"/>
  <hh:font id="1" face="맑은 고딕" type="TTF" isEmbedded="0"/>
  <hh:font id="2" face="휴먼명조" type="TTF" isEmbedded="0"/>
</hh:fontFaces>
```

언어별로 별도 `<hh:fontFaces>` 그룹 (HANGUL, LATIN, HANJA, JAPANESE, OTHER, SYMBOL, USER). `<hh:fontRef hangul="1">`은 HANGUL 그룹의 id=1 폰트를 가리킨다.

## 자주 쓰이는 값 상수

| 속성 | 값 | 의미 |
|------|-----|------|
| `<hh:align horizontal=>` | `LEFT`, `RIGHT`, `CENTER`, `JUSTIFY`, `DISTRIBUTE` | 정렬 |
| `<hh:lineSpacing type=>` | `PERCENT`, `FIXED`, `BETWEEN_LINES`, `AT_LEAST` | 줄간격 방식 |
| `<hp:pagePr landscape=>` | `NARROWLY`, `WIDELY` | 용지 방향 (세로/가로) |
| `<hh:underline type=>` | `NONE`, `BOTTOM`, `CENTER`, `TOP` | 밑줄 위치 |
| `<hh:underline shape=>` | `SOLID`, `DASH`, `DOT`, `DASH_DOT`, `DOUBLE`, `WAVE` | 밑줄 모양 |

## 참고 구현

실제 출력 XML을 보려면:

```bash
./hwpx unpack templates/공문서_기본.hwpx /tmp/view
cat /tmp/view/Contents/section0.xml
cat /tmp/view/Contents/header.xml
```

실제 예제가 스펙 PDF보다 빠르게 이해된다.
