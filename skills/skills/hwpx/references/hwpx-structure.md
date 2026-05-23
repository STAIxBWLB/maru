# HWPX 파일 구조

HWPX는 **OWPML**(Open Word-Processor Markup Language)로 표현된 문서를 zip 컨테이너에 담은 포맷이다. 표준 번호는 **KS X 6101** (2011-12-30 제정), 한/글 2021부터 기본 저장 포맷이며 정부 공문서 법정 형식. 구조 철학은 EPUB의 OCF(Open Container Format) + OPF(Open Packaging Format)에서 유래.

## Zip 컨테이너 레이아웃

```
<document>.hwpx  (zip)
├── mimetype                        ← 첫 엔트리, STORED(무압축), 고정값
├── version.xml                     ← OWPML 버전 + 생성 도구 정보
├── settings.xml                    ← caret 위치, 외부 설정
├── Contents/
│   ├── content.hpf                 ← OPF 스타일 manifest (metadata+spine)
│   ├── header.xml                  ← 스타일 딕셔너리 (charPr/paraPr/style 등)
│   ├── section0.xml                ← 섹션 1 본문
│   ├── section1.xml                ← 섹션 2 본문 (있을 경우)
│   └── …
├── META-INF/
│   ├── container.xml               ← 루트 문서 경로 지정
│   ├── manifest.xml                ← rendition 목록
│   └── container.rdf               ← 암호화 정보 (있을 때)
├── BinData/                        ← 이미지·OLE 원본 (예: 0.jpg, 1.png)
├── Scripts/                        ← headerScripts, sourceScripts
└── Preview/                        ← 미리보기 이미지/텍스트
```

## 필수 규칙

### 1. mimetype이 zip의 첫 엔트리, STORED

```
mimetype 파일 내용: application/hwp+zip
압축 방식: ZIP_STORED (0)
```

이 규칙은 EPUB/ODF와 동일하다. `file(1)` 유틸리티와 Hancom Office 모두 **첫 30바이트**를 읽어 포맷을 식별한다. DEFLATE로 압축되어 있거나 다른 파일이 먼저 나오면 Hancom Office에서 열리지 않는다.

Python으로 직접 zip을 만들 때:

```python
import zipfile
with zipfile.ZipFile(out, "w") as zf:
    info = zipfile.ZipInfo("mimetype")
    info.compress_type = zipfile.ZIP_STORED
    zf.writestr(info, b"application/hwp+zip")
    # 이후 나머지 파일은 ZIP_DEFLATED로 추가
```

`./hwpx repack` 커맨드는 이를 자동 처리한다.

### 2. header.xml = 스타일 딕셔너리, section*.xml = 흐름

DOCX의 `styles.xml` + `document.xml` 분리와 유사하지만, HWPX는 스타일 참조가 **string id가 아닌 정수 ID**다.

```xml
<!-- header.xml 내부 -->
<hh:charPr id="0"> ... </hh:charPr>
<hh:charPr id="1"> ... </hh:charPr>
<hh:paraPr id="0"> ... </hh:paraPr>
<hh:style id="0" name="바탕글"> ... </hh:style>

<!-- section0.xml 내부 -->
<hp:p paraPrIDRef="0" styleIDRef="0">
  <hp:run charPrIDRef="0">
    <hp:t>내용</hp:t>
  </hp:run>
</hp:p>
```

ID는 **위치 기반**이다. 중간에 `charPr`를 삭제하면 뒤의 ID가 밀리면서 모든 참조가 깨진다. 스타일 추가는 항상 append, 삭제는 피하거나 전체 renumbering이 필요하다.

### 3. BinData는 숫자 파일명

이미지는 `BinData/0.jpg`, `BinData/1.png` 식으로 저장되고, `content.hpf` manifest에 매핑이 기록된다. `section*.xml`에서는 binData ID로 참조.

## 섹션 / 단락 / 런 모델

```xml
<hp:sec>
  <hp:pagePr> ... </hp:pagePr>     <!-- 페이지 설정 (여백, 용지 크기) -->
  <hp:p paraPrIDRef="0">           <!-- 단락 -->
    <hp:run charPrIDRef="0">       <!-- 런 (문자 속성 단위) -->
      <hp:t>안녕하세요</hp:t>       <!-- 실제 텍스트 -->
      <hp:lineBreak/>              <!-- 줄바꿈 -->
      <hp:t>다음 줄</hp:t>
    </hp:run>
    <hp:run charPrIDRef="1">       <!-- 다른 속성의 런 -->
      <hp:t>강조된 부분</hp:t>
    </hp:run>
  </hp:p>
</hp:sec>
```

- **단락**은 paraPr로 정렬·들여쓰기·줄간격을 결정
- **런**은 charPr로 폰트·크기·색상·굵기를 결정
- **`<hp:t>`가 실제 텍스트 leaf**
- 런 경계를 가로지르는 텍스트는 단순 find/replace가 실패할 수 있음. 그런 경우 unpack 후 XML 구조를 직접 보정한다.

## 주요 네임스페이스

| 접두어 | 의미 | 주로 등장하는 파일 |
|--------|------|--------------------|
| `hp:` | 단락·런 content (본문) | `section*.xml` |
| `hh:` | 문서 구조·스타일 | `header.xml` |
| `hc:` | 공통 타입 (색상, 점) | 전체 |
| `hs:` | 설정 | `settings.xml` |
| `ha:` | 애플리케이션 정보 | `settings.xml`, `version.xml` |
| `hp10:` | 확장 네임스페이스 (신규 기능) | 혼합 |
| `opf:`, `dc:` | OPF manifest, Dublin Core metadata | `content.hpf` |
| `ocf:` | Open Container | `META-INF/container.xml` |

정확한 네임스페이스 URI는 파일마다 선언부를 참조한다.

## `Contents/content.hpf` (OPF manifest)

EPUB 스타일의 패키지 파일. 세 섹션:

1. `<opf:metadata>` — Dublin Core 메타 (title, creator, date, identifier)
2. `<opf:manifest>` — 패키지 내부 모든 파일 목록 (id, href, media-type)
3. `<opf:spine>` — 섹션 파일 재생 순서

새 이미지·섹션을 추가할 때 이 파일을 갱신하지 않으면 Hancom Office가 파일을 인식하지 못한다.

## DOCX와의 주요 차이점

| 항목 | HWPX | DOCX |
|------|------|------|
| 매니페스트 | `content.hpf` (OPF 스타일) | `[Content_Types].xml` + `_rels/*.rels` |
| 스타일 참조 | 정수 ID (`charPrIDRef="3"`) | 문자열 이름 (`w:val="Heading1"`) |
| 본문 위치 | `Contents/sectionN.xml` (섹션별 분리) | `word/document.xml` (단일 파일) |
| 폰트 처리 | 7언어 병행 (`<hh:fontRef>`로 한글/라틴/한자/일본어/기타/기호/사용자 동시) | 단일 폰트명 |
| 이미지 참조 | 숫자 파일명 + content.hpf manifest ID | `rId` 문자열 + `_rels` |
| 확장 문법 | `hp10:` 네임스페이스 | 메이저 버전 스펙 |

## 검증 체크리스트

`./hwpx validate`가 확인하는 항목:

1. `mimetype`이 zip의 첫 엔트리
2. `mimetype` 엔트리가 `ZIP_STORED` (compression method 0)
3. `mimetype` 내용이 정확히 `application/hwp+zip`
4. `Contents/content.hpf`, `Contents/header.xml`, `Contents/section0.xml` 존재
5. 모든 `.xml` / `.hpf` 파일이 lxml로 파싱 가능

실패 시 exit 2.

## 추가 자료

- [KS X 6101 OWPML 표준](https://www.kssn.net/search/stddetail.do?itemNo=K001010119985)
- [한컴테크 HWPX 포맷 구조](https://tech.hancom.com/hwpxformat/)
- [hwpx-owpml-model (Hancom 공식 C++ 레퍼런스)](https://github.com/hancom-io/hwpx-owpml-model)
- [hwpxlib (Java 구현)](https://github.com/neolord0/hwpxlib)
