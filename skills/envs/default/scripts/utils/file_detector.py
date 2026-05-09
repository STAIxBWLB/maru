"""file_detector.py — 파일 타입 감지 유틸리티"""
from pathlib import Path


SUPPORTED_TYPES = {
    '.hwp': 'HWP v5 (한글 문서)',
    '.hwpx': 'HWPX (한글 문서 XML)',
    '.pdf': 'PDF 문서',
}


def detect_file_type(filepath: Path) -> str:
    """파일 타입 감지 (python-magic 우선, 확장자 폴백)"""
    try:
        import magic
        mime = magic.from_file(str(filepath), mime=True)
        return mime
    except (ImportError, Exception):
        return filepath.suffix.lower()


def is_supported(filepath: Path) -> bool:
    """지원하는 파일 형식인지 확인"""
    return filepath.suffix.lower() in SUPPORTED_TYPES


def get_encoding(filepath: Path) -> str:
    """텍스트 파일 인코딩 감지"""
    try:
        import chardet
        raw = filepath.read_bytes()
        result = chardet.detect(raw)
        return result.get('encoding', 'utf-8') or 'utf-8'
    except Exception:
        return 'utf-8'
