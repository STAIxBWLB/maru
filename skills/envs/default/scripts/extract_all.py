#!/usr/bin/env python3
"""extract_all.py — HWP/PDF 통합 텍스트 추출 유틸리티"""
import click
from pathlib import Path
from tqdm import tqdm


def extract_hwp(filepath: Path) -> str:
    """HWP v5 파일에서 텍스트 추출
    1순위: libhwp (Rust 기반, 빠름)
    2순위: pyhwp hwp5txt (정확, 제어코드 없음)
    3순위: olefile 직접 파싱 (최후 수단)
    """
    import sys, subprocess

    # 1순위: libhwp
    try:
        from libhwp import HWPReader
        hwp = HWPReader(str(filepath))
        return "\n".join(str(p) for p in hwp.find_all('paragraph'))
    except BaseException:
        pass

    # 2순위: pyhwp hwp5txt
    hwp5txt = Path(sys.executable).parent / 'hwp5txt'
    if hwp5txt.exists():
        result = subprocess.run(
            [str(hwp5txt), str(filepath)],
            capture_output=True
        )
        if result.returncode == 0:
            return result.stdout.decode('utf-8', errors='ignore')

    # 3순위: olefile 직접 파싱
    import olefile, zlib, struct
    f = olefile.OleFileIO(str(filepath))
    header = f.openstream("FileHeader").read()
    compressed = (header[36] & 1) == 1
    text_parts = []
    for d in sorted(f.listdir()):
        if d[0] != "BodyText":
            continue
        data = f.openstream("/".join(d)).read()
        if compressed:
            data = zlib.decompress(data, -15)
        i = 0
        while i < len(data):
            h = struct.unpack_from("<I", data, i)[0]
            rtype = h & 0x3ff
            rlen = (h >> 20) & 0xfff
            if rlen == 0xFFF:
                if i + 8 > len(data):
                    break
                rlen = struct.unpack_from("<I", data, i + 4)[0]
                i += 4
            if rtype == 67:  # HWPTAG_PARA_TEXT
                raw = data[i+4:i+4+rlen]
                para = raw.decode('utf-16le', errors='ignore')
                para = ''.join(c if c >= ' ' or c in '\t\n' else '' for c in para)
                if para.strip():
                    text_parts.append(para)
            i += 4 + rlen
    return "\n".join(text_parts)


def extract_hwpx(filepath: Path) -> str:
    """HWPX 파일에서 텍스트 추출 (zipfile + BeautifulSoup, 단락 구분 보존)"""
    import zipfile
    from bs4 import BeautifulSoup
    with zipfile.ZipFile(filepath, 'r') as z:
        sections = sorted([
            n for n in z.namelist()
            if n.startswith('Contents/section') and n.endswith('.xml')
        ])
        all_paras = []
        for section in sections:
            soup = BeautifulSoup(z.read(section), 'lxml-xml')
            # hp:p = 단락, 각 단락을 개별 추출해 줄바꿈 보존
            for para in soup.find_all('hp:p'):
                text = para.get_text(separator='', strip=False)
                if text.strip():
                    all_paras.append(text)
        return "\n".join(all_paras)


def extract_pdf(filepath: Path) -> str:
    """PDF 파일에서 텍스트 추출 (PyMuPDF 우선, pdfminer 폴백)"""
    try:
        import pymupdf
        doc = pymupdf.open(str(filepath))
        return "\n".join(page.get_text() for page in doc)
    except Exception:
        from pdfminer.high_level import extract_text
        return extract_text(str(filepath))


EXTRACTORS = {
    '.hwp': extract_hwp,
    '.hwpx': extract_hwpx,
    '.pdf': extract_pdf,
}


@click.command()
@click.option('--input', '-i', 'input_dir', required=True, type=click.Path(exists=True),
              help='입력 디렉토리 경로')
@click.option('--output', '-o', 'output_dir', default='output/text',
              type=click.Path(), help='출력 디렉토리 경로 (기본: output/text)')
@click.option('--recursive/--no-recursive', default=True,
              help='하위 디렉토리 재귀 탐색 (기본: True)')
def main(input_dir, output_dir, recursive):
    """HWP, HWPX, PDF 파일에서 텍스트를 추출합니다."""
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    glob_fn = input_path.rglob if recursive else input_path.glob
    files = [f for f in glob_fn('*') if f.suffix.lower() in EXTRACTORS]

    if not files:
        click.echo(f"처리할 파일이 없습니다: {input_path}")
        return

    results = {'success': 0, 'failed': 0}

    for filepath in tqdm(files, desc="추출 중"):
        try:
            extractor = EXTRACTORS[filepath.suffix.lower()]
            text = extractor(filepath)
            out_file = output_path / f"{filepath.stem}.txt"
            out_file.write_text(text, encoding='utf-8')
            results['success'] += 1
        except Exception as e:
            click.echo(f"❌ {filepath.name}: {e}", err=True)
            results['failed'] += 1

    click.echo(f"\n✅ 완료: {results['success']}건 성공, {results['failed']}건 실패")
    click.echo(f"   출력 위치: {output_path.resolve()}")


if __name__ == '__main__':
    main()
