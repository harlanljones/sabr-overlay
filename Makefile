SRC := manifest.json background.js content.js
XPI := sabr-overlay.xpi

.PHONY: build lint run clean

build: $(XPI)

$(XPI): $(SRC)
	rm -f $@ && zip -X $@ $(SRC)

lint:
	npx --yes web-ext lint --source-dir . --ignore-files 'docs/**' '.github/**' Makefile '*.md' LICENSE .editorconfig .gitignore

run:
	npx --yes web-ext run --source-dir . --start-url https://tv.youtube.com

clean:
	rm -f $(XPI)
