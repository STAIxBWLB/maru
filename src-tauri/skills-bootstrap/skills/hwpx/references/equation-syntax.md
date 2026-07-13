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

정품 렌더 대비 다음은 근사 처리된다. 정밀 수식이 필요하면 한컴오피스에서 확인.

- **GD-1 행렬(matrix)**: 열 정렬 문자 `&`를 조판하지 않고 공백으로 취급.
- **GD-2 큰연산자 극한**: `sum`·`int` 심볼은 나오나 위·아래 극한을 연산자에 붙여 배치하지 못함(첨자 배치로 근사).
- **GD-3 복잡 구분자**: 크기 자동조절 괄호 등 미지원.

## 한계: 읽기·렌더 전용

수식을 **저작·편집하는 CLI 표면은 없다**. `new`/`edit`로 수식을 삽입·수정할 수 없고, 수식 스크립트는 왕복 시 원본 바이트로만 보존된다(cross-format 합성 대상 아님). 수식이 포함된 문서를 렌더/추출하는 것만 지원한다.

전체 능력·한계: `capability-matrix.md`. 갭 SSOT: `dev/hwp-cli/docs/design/12-feature-gaps.md`.
