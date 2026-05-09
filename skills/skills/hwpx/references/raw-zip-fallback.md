# 원시 zipfile + lxml 폴백

python-hwpx 없이, 또는 python-hwpx가 커버하지 않는 연산을 위해 zip과 XML을 직접 다루는 방법.

## 언제 사용?

1. python-hwpx가 파싱 중 오류를 내는 문서
2. python-hwpx API에 없는 구조 변경 (복잡한 매니페스트 재배치, 암호화 처리)
3. 라이선스 제약(Non-Commercial)으로 python-hwpx를 쓸 수 없는 상황
4. 이해·학습용 (실제 구조 확인)

대부분의 경우 `./hwpx unpack` → `Edit` 도구 → `./hwpx repack` 흐름이 더 안전하고 짧다.

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

❌ `zip -r output.hwpx dir/` 셸 명령 — mimetype이 첫 엔트리·STORED 보장 안 됨.
❌ `zipfile.ZipFile("out.hwpx", "w")`에 mimetype을 나중에 추가 — 순서가 어긋나면 Hancom Office에서 안 열림.
❌ XML 재직렬화 시 `xml_declaration=False` — OWPML 파일은 XML 선언 필수.

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
| `BadZipFile` | 파일이 실제로 HWP 바이너리 | file(1)로 확인 → hwp-toolkit 사용 |
| `XMLSyntaxError` on `content.hpf` | 파일이 잘림 | zip 무결성 확인 (`unzip -t`) |
| 한글이 `&#xXXXX;`로 보임 | XML 선언 누락으로 UTF-8 가정 실패 | `xml_declaration=True, standalone=True`로 쓰기 |
| mimetype 체크 실패 | 0바이트 또는 BOM 포함 | `b"application/hwp+zip"` 정확히 바이트 (공백·개행 금지) |

## 검증

직접 만든 zip은 반드시:

```bash
./hwpx validate output.hwpx
unzip -l output.hwpx | head -5   # mimetype이 첫 줄인지
unzip -p output.hwpx mimetype     # application/hwp+zip
```

## 참고 구현

- `hwpxlib` (Java): https://github.com/neolord0/hwpxlib — 같은 작업을 Java로 어떻게 하는지 참조
- `hwp5` (Python, 바이너리 HWP 전용): https://pypi.org/project/pyhwp/ — HWPX 아님
- `hwpx-owpml-model` (C++, Hancom 공식): https://github.com/hancom-io/hwpx-owpml-model — element 이름 ground truth
