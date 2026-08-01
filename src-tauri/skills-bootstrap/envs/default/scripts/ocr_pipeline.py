#!/usr/bin/env python3
"""ocr_pipeline.py — 스캔 PDF OCR 파이프라인 (pdf2image + pytesseract)"""
import click
from pathlib import Path
from tqdm import tqdm


def ocr_pdf(pdf_path: Path, output_dir: Path, lang: str = 'kor+eng', dpi: int = 300):
    from pdf2image import convert_from_path
    import pytesseract

    pages = convert_from_path(str(pdf_path), dpi=dpi)
    texts = []
    for i, page in enumerate(pages):
        text = pytesseract.image_to_string(page, lang=lang)
        texts.append(f"--- Page {i+1} ---\n{text}")

    out = output_dir / f"{pdf_path.stem}_ocr.txt"
    out.write_text("\n\n".join(texts), encoding='utf-8')
    return len(pages)


def ocr_pdf_searchable(pdf_path: Path, output_dir: Path, lang: str = 'kor+eng'):
    """OCRmyPDF를 사용해 검색 가능한 PDF/A 생성"""
    import subprocess
    out = output_dir / f"{pdf_path.stem}_searchable.pdf"
    result = subprocess.run([
        'ocrmypdf',
        '-l', lang,
        '--deskew',
        '--rotate-pages',
        '--output-type', 'pdfa',
        str(pdf_path),
        str(out)
    ], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    return out


@click.command()
@click.option('--input', '-i', 'input_dir', required=True, type=click.Path(exists=True))
@click.option('--output', '-o', 'output_dir', default='output/ocr', type=click.Path())
@click.option('--lang', default='kor+eng', help='Tesseract 언어 (기본: kor+eng)')
@click.option('--dpi', default=300, help='변환 해상도 (기본: 300)')
@click.option('--searchable-pdf/--no-searchable-pdf', default=False,
              help='검색 가능한 PDF 생성 (ocrmypdf 필요)')
def main(input_dir, output_dir, lang, dpi, searchable_pdf):
    """스캔된 PDF에서 OCR로 텍스트를 추출합니다."""
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    pdf_files = list(input_path.rglob('*.pdf'))
    if not pdf_files:
        click.echo("처리할 PDF 파일이 없습니다.")
        return

    for pdf_path in tqdm(pdf_files, desc="OCR 처리 중"):
        try:
            pages = ocr_pdf(pdf_path, output_path, lang=lang, dpi=dpi)
            click.echo(f"  ✅ {pdf_path.name}: {pages}페이지 OCR 완료")

            if searchable_pdf:
                out = ocr_pdf_searchable(pdf_path, output_path, lang=lang)
                click.echo(f"  📄 검색 가능한 PDF 생성: {out.name}")
        except Exception as e:
            click.echo(f"❌ {pdf_path.name}: {e}", err=True)


if __name__ == '__main__':
    main()
