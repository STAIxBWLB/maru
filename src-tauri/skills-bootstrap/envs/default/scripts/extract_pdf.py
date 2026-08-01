#!/usr/bin/env python3
"""extract_pdf.py — PDF 전용 추출기 (텍스트·표·이미지)"""
import click
from pathlib import Path
from tqdm import tqdm


def extract_text_pymupdf(pdf_path: Path, output_dir: Path):
    import pymupdf
    doc = pymupdf.open(str(pdf_path))
    text = "\n".join(page.get_text() for page in doc)
    out = output_dir / "text" / f"{pdf_path.stem}.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding='utf-8')
    return len(doc)


def extract_tables_pdfplumber(pdf_path: Path, output_dir: Path):
    import pdfplumber, csv
    tables_found = 0
    with pdfplumber.open(str(pdf_path)) as pdf:
        for i, page in enumerate(pdf.pages):
            table = page.extract_table()
            if table:
                out = output_dir / "tables" / f"{pdf_path.stem}_p{i+1}.csv"
                out.parent.mkdir(parents=True, exist_ok=True)
                with open(out, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    writer.writerows(table)
                tables_found += 1
    return tables_found


def extract_images_pymupdf(pdf_path: Path, output_dir: Path):
    import pymupdf
    doc = pymupdf.open(str(pdf_path))
    img_count = 0
    for page_num, page in enumerate(doc):
        for img_idx, img in enumerate(page.get_images(full=True)):
            xref = img[0]
            base_image = doc.extract_image(xref)
            img_bytes = base_image["image"]
            img_ext = base_image["ext"]
            out = output_dir / "images" / f"{pdf_path.stem}_p{page_num+1}_{img_idx+1}.{img_ext}"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(img_bytes)
            img_count += 1
    return img_count


@click.command()
@click.option('--input', '-i', 'input_dir', required=True, type=click.Path(exists=True))
@click.option('--output', '-o', 'output_dir', default='output', type=click.Path())
@click.option('--text/--no-text', default=True, help='텍스트 추출')
@click.option('--tables/--no-tables', default=True, help='표 추출')
@click.option('--images/--no-images', default=False, help='이미지 추출')
def main(input_dir, output_dir, text, tables, images):
    """PDF 파일에서 텍스트, 표, 이미지를 추출합니다."""
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    pdf_files = list(input_path.rglob('*.pdf'))

    if not pdf_files:
        click.echo("처리할 PDF 파일이 없습니다.")
        return

    for pdf_path in tqdm(pdf_files, desc="PDF 처리 중"):
        try:
            if text:
                pages = extract_text_pymupdf(pdf_path, output_path)
                click.echo(f"  📄 {pdf_path.name}: {pages}페이지 텍스트 추출")
            if tables:
                n = extract_tables_pdfplumber(pdf_path, output_path)
                if n:
                    click.echo(f"  📊 {pdf_path.name}: {n}개 표 추출")
            if images:
                n = extract_images_pymupdf(pdf_path, output_path)
                if n:
                    click.echo(f"  🖼️  {pdf_path.name}: {n}개 이미지 추출")
        except Exception as e:
            click.echo(f"❌ {pdf_path.name}: {e}", err=True)


if __name__ == '__main__':
    main()
