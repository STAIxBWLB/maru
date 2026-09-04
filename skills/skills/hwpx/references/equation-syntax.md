# 수식(Equation) 지원 문법

hwp-cli는 한글 수식 개체를 **mini-TeX 조판기**로 렌더한다. 한글 수식은 글립 배치가 아니라 텍스트 스크립트(한컴 수식 spec rev1.2, EQN 호환)로 저장되며, hwp-cli가 이를 파싱해 box model로 배치한다.

## 자동 렌더 (사용자 플래그 없음)

수식은 `render`(png/svg)·`to-pdf`/`render-pdf`·`convert --to pdf`에서 **자동 조판**된다. 별도 옵션이나 서브커맨드가 없다.

- **HWPX** `<hp:equation>`(read 시 script 캡처)
- **HWP5** 바이너리 `eqed` 컨트롤 (child `EQEDIT` 레코드 script)

두 포맷의 같은 스크립트는 동일하게 렌더된다.

정본: `dev/hwp-cli/crates/hwp-render/src/equation.rs` (모듈 헤더 1~10행이 지원/미지원 SSOT).

## 지원 문법

| 문법 | 의미 |
|------|------|
| `a over b` | 분수 (분수선 있음). 중위 연산자, 앞·뒤 원자 1개씩만 결합 |
| `a atop b` | 분수선 없는 상하 배치 |
| `sqrt x` / `sqrt {a+b}` | 근호 (vinculum 포함) |
| `x^2` / `x_i` | 위첨자 / 아래첨자 |
| `{ ... }` | 그룹 (결합 범위 지정) |
| `~` / `` ` `` | 공백 (1 em / 0.25 em) |
| `#` | 줄바꿈 (여러 행을 세로로 쌓음) |
| `alpha`..`omega`, `ALPHA`..`OMEGA` | 그리스 소문자·대문자 |
| `sum`, `int`, `sqrt` 등 | 기호 (∑, ∫, √ ...) |
| `sin`/`cos`/`log`/`lim` 등 | 함수어 (로만체) |

**변수 이탤릭**: 매핑되지 않은 단일 라틴 문자(a, x, E, m ...)는 변수로 이탤릭 렌더. 함수어·숫자·그리스는 로만(정체).

**결합 규칙(over/atop)**: `alpha + beta over 2` = α + (β/2). 전체를 묶으려면 `{alpha+beta} over 2`.

## 예시

```
a over b                 # 분수 a/b
x^2 + y_i                # 첨자
sqrt {a+b}               # 근호
E = m c^2                # 변수 이탤릭 (E, m, c)
{-b +- sqrt{b^2-4ac}} over {2a}
alpha + beta over 2      # α + (β/2)  ← over는 앞뒤 원자만 결합
```

## 근사·미지원 (doc12 §4 GD-1~3)

기준 구현과 비교하여 다음은 근사 처리된다. 해당 표현의 정밀 조판이 필수인 생성 요청은 현재
지원 범위를 벗어난다. 에이전트는 명령 실행 전에 요청을 preflight해 명시적으로 거부해야
한다. 현재 CLI에는 요청의 정밀도 요구를 해석해 자동 거부하는 capability schema가 없다.
기존 문서의 읽기·렌더 요청에서는 아래 근사 결과를 반환할 수 있으나 pixel parity를 보장하지
않는다.

- **GD-1 행렬(matrix)**: 열 정렬 문자 `&`를 조판하지 않고 공백으로 취급.
- **GD-2 큰연산자 극한**: `sum`·`int` 심볼은 나오나 위·아래 극한을 연산자에 붙여 배치하지 못함(첨자 배치로 근사).
- **GD-3 복잡 구분자**: 크기 자동조절 괄호 등 미지원.

## writer와 public 저작 표면

HWPX writer는 semantic IR에 이미 들어 있는 수식 script를 `<hp:equation>`으로 합성할 수 있고,
기존 HWPX 수식의 script와 지원 속성을 왕복한다. 따라서 HWP5→HWPX나 JSON IR 재생성 같은
semantic write 경로의 수식은 writer 대상이다.

안정적인 전용 수식 저작·편집 플래그는 없다. 다만
`hwp new --from document.json -o output.hwpx`가 받는 내부 serde JSON IR의
`GenericControl.equation.script`를 통해 신규 수식을 전달하는 저수준 경로는 존재한다.
이 구조는 디버그·왕복용 내부 모델이며 versioned authoring schema가 아니다. 필드명과 표현이
릴리스 사이에 바뀔 수 있고, 고수준 유효성 검사도 제공하지 않으므로 "수식 저작 API 지원"으로
표시하거나 장기 자동화 계약으로 사용하지 않는다.

전용 authoring API가 필요한 요청은 지원되지 않는 것으로 preflight한다. 내부 JSON IR을
명시적으로 선택한 작업은 hwp-cli 버전을 고정하고, 생성 파일에 대해 `hwp validate --json`,
semantic reopen, 전 페이지 render를 자동 실행해야 한다. 실패 시 본문 텍스트나 이미지로
조용히 대체하지 않는다.

전체 능력·한계: `capability-matrix.md`. 갭 SSOT: `dev/hwp-cli/docs/design/12-feature-gaps.md`.
