VENV = .venv
BIN  = $(VENV)/bin
PY   = $(BIN)/python3

NODE_MODULES = node_modules

$(VENV): pyproject.toml
	uv sync

$(NODE_MODULES): package.json
	pnpm install

.PHONY: setup process-hwp process-pdf process-all ocr clean verify help

help:           ## 사용 가능한 명령어 목록
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: $(VENV) $(NODE_MODULES) ## 전체 환경 구성
	./setup.sh

process-hwp: $(VENV) ## input/hwp/ 의 모든 HWP 파일 처리
	$(PY) scripts/extract_all.py --input input/hwp/ --output output/text/

process-pdf: $(VENV) ## input/pdf/ 의 모든 PDF 파일 처리
	$(PY) scripts/extract_all.py --input input/pdf/ --output output/text/

process-all: $(VENV) ## input/ 의 모든 HWP·PDF 파일 처리
	$(PY) scripts/extract_all.py --input input/ --output output/text/

ocr: $(VENV)    ## 스캔 PDF OCR 처리
	$(PY) scripts/ocr_pipeline.py --input input/pdf/ --output output/ocr/

verify:         ## 시스템 의존성 확인
	@command -v uv >/dev/null || (echo "❌ uv 미설치 (curl -LsSf https://astral.sh/uv/install.sh | sh)" && exit 1)
	@command -v tesseract >/dev/null || (echo "❌ tesseract 미설치 (brew install tesseract)" && exit 1)
	@command -v pdftotext >/dev/null || (echo "❌ poppler-utils 미설치 (brew install poppler)" && exit 1)
	@test -d $(VENV) || (echo "❌ 가상환경 없음 (make setup 실행)" && exit 1)
	@command -v pnpm >/dev/null || (echo "❌ pnpm 미설치 (brew install pnpm)" && exit 1)
	@test -d $(NODE_MODULES)/docx || (echo "❌ docx 패키지 없음 (pnpm install 실행)" && exit 1)
	@echo "✅ 모든 시스템 의존성 확인됨"

sync:           ## pyproject.toml/package.json 변경 시 패키지 동기화
	uv sync
	pnpm install

clean:          ## 임시 파일 및 가상환경 삭제
	rm -rf $(VENV) $(NODE_MODULES) temp/* output/* logs/*
	find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true
