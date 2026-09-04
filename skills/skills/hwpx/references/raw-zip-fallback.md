# 원시 zipfile + lxml 처리

HWPX를 zip과 XML로 직접 다루는 방법.

## 언제 사용?

1. 단순 CLI가 커버하지 않는 plain HWPX 구조 변경 (복잡한 매니페스트 재배치)
2. 런 경계를 넘는 치환처럼 텍스트 치환만으로 부족한 문서
3. 이해·학습용 (실제 구조 확인)

대부분의 경우 `./hwpx unpack` → 편집 → `./hwpx repack` 흐름이 더 안전하고 짧다.
암호화·DRM·전자서명 문서는 이 fallback의 지원 대상이 아니다. 해석·보존을 보장할 수 없으면
출력 전에 실패하며, 보호를 제거하거나 다시 서명하는 절차를 제공하지 않는다.

아래 코드는 구조 학습용 최소 예제다. 운영 성공 경로는 `scripts/hwpx_xml.py`의 bounded
stream-copy와 `./hwpx` 명령을 사용한다. `ZipFile.read`/`extractall`로 모든 payload를
무제한 확장하는 코드를 자동화에 사용하지 않는다.
구조 편집과 repack은 package regeneration이므로 byte identity를 보장하지 않는다.
미수정 part의 바이트 보존이 필요한 경우 replace-only HWPX package patch 경로를 사용한다.

## 최소 읽기

```python
import zipfile
from lxml import etree

NS = {
    "hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
    "hh": "http://www.hancom.co.kr/hwpml/2011/head",
    "hc": "http://www.hancom.co.kr/hwpml/2011/core",
    "opf": "http://www.idpf.org/2007/opf/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "ocf": "urn:oasis:names:tc:opendocument:xmlns:container",
}

with zipfile.ZipFile("document.hwpx") as zf:
    sec = etree.fromstring(zf.read("Contents/section0.xml"))
    for para in sec.iter("{http://www.hancom.co.kr/hwpml/2011/paragraph}p"):
        text = "".join(
            t.text or ""
            for t in para.iter("{http://www.hancom.co.kr/hwpml/2011/paragraph}t")
        )
        print(text)
```

## 최소 쓰기 (find/replace)

```python
import shutil
import zipfile
from pathlib import Path
from lxml import etree

HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"

src = Path("input.hwpx")
dst = Path("output.hwpx")
workdir = Path("/tmp/hwpx_work")
workdir.mkdir(exist_ok=True)

# 1) unpack
with zipfile.ZipFile(src) as zf:
    zf.extractall(workdir)

# 2) edit
sec_path = workdir / "Contents" / "section0.xml"
tree = etree.parse(sec_path)
for t in tree.iter(f"{HP}t"):
    if t.text:
        t.text = t.text.replace("{{제목}}", "실제 제목")
tree.write(sec_path, encoding="utf-8", xml_declaration=True, standalone=True)

# 3) repack — mimetype을 첫 엔트리로, STORED로
with zipfile.ZipFile(dst, "w") as zf:
    info = zipfile.ZipInfo("mimetype")
    info.compress_type = zipfile.ZIP_STORED
    zf.writestr(info, (workdir / "mimetype").read_bytes())
    for path in sorted(workdir.rglob("*")):
        if path.is_dir() or path.name == "mimetype":
            continue
        zf.write(path, path.relative_to(workdir), compress_type=zipfile.ZIP_DEFLATED)

shutil.rmtree(workdir)
```

## 절대 하면 안 되는 것

- 금지: `zip -r output.hwpx dir/` 셸 명령. mimetype이 첫 엔트리·STORED임을 보장하지 못함.
- 금지: `zipfile.ZipFile("out.hwpx", "w")`에 mimetype을 나중에 추가. 소비자가 포맷을 인식하지 못할 수 있음.
- 금지: XML 재직렬화 시 `xml_declaration=False`. OWPML 파일은 XML 선언 필수.

## Manifest(`Contents/content.hpf`) 갱신

새 이미지·섹션을 추가했다면 manifest도 갱신해야 Hancom Office가 파일을 인식한다.

```python
from lxml import etree

OPF = "{http://www.idpf.org/2007/opf/}"

hpf_path = workdir / "Contents" / "content.hpf"
tree = etree.parse(hpf_path)
root = tree.getroot()

# <opf:manifest> 에 새 항목 추가
manifest = root.find(f"{OPF}manifest")
item = etree.SubElement(manifest, f"{OPF}item", attrib={
    "id": "image2",
    "href": "BinData/image2.jpg",
    "media-type": "image/jpeg",
})

# 필요하면 <opf:spine>에도
spine = root.find(f"{OPF}spine")
etree.SubElement(spine, f"{OPF}itemref", attrib={"idref": "section1"})

tree.write(hpf_path, encoding="utf-8", xml_declaration=True, standalone=True)
```

## 네임스페이스를 일일이 안 적기

```python
nsmap = {
    "hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
    "hh": "http://www.hancom.co.kr/hwpml/2011/head",
}
for t in tree.xpath("//hp:t", namespaces=nsmap):
    ...
```

lxml에서는 `xpath(..., namespaces=...)` 형태가 가장 깔끔하다.

## 파일 파싱 시 흔한 오류

| 증상 | 원인 | 해결 |
|------|------|------|
| `BadZipFile` | 파일이 실제로 HWP 바이너리 | file(1)로 확인 → hwp-cli (`hwp cat`) 사용 또는 `./hwpx read`(자동 위임) |
| `XMLSyntaxError` on `content.hpf` | 파일이 잘림 | zip 무결성 확인 (`unzip -t`) |
| 한글이 `&#xXXXX;`로 보임 | XML 선언 누락으로 UTF-8 가정 실패 | `xml_declaration=True, standalone=True`로 쓰기 |
| mimetype 체크 실패 | 0바이트 또는 BOM 포함 | `b"application/hwp+zip"` 정확히 바이트 (공백·개행 금지) |

## 검증

직접 실험한 zip도 성공으로 게시하기 전에 자동 검증해야 한다:

```bash
./hwpx validate output.hwpx
```

`styled` 경로는 최종 staging 파일에 대해 중복 이름, entry count, 단일·전체 uncompressed
크기, 압축률, XML 크기와 parse를 bounded 로컬 검사한 뒤 실제 resolved
`hwp validate --json`까지 통과해야 publish한다. 사람이 압축 목록을 보거나 한/글에서 파일을
여는 것은 성공 판정의 대체 수단이 아니다.

## 참고 구현

- `hwpxlib` (Java): https://github.com/neolord0/hwpxlib — 같은 작업을 Java로 어떻게 하는지 참조
- `hwp5` (Python, 바이너리 HWP 전용): https://pypi.org/project/pyhwp/ — HWPX 아님
- `hwpx-owpml-model` (C++, Hancom 공식): https://github.com/hancom-io/hwpx-owpml-model — element 이름 ground truth
