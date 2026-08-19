# Lasso - Cowboy blockchain console
#
# Day to day:    make dev / make check
# Binaries:      make binaries   (cross-compiles all targets, like CI)
# Release:       make release    (binaries + checksums + GitHub release)

VERSION := $(shell node -p "require('./package.json').version")
TARGETS := darwin-arm64 darwin-x64 linux-x64 linux-arm64

.PHONY: help install dev build test typecheck check binaries binary install-local release clean

help:
	@echo "lasso v$(VERSION)"
	@echo ""
	@echo "  make install        npm ci"
	@echo "  make dev            run from source (tsx)"
	@echo "  make build          bundle to dist/ (tsup)"
	@echo "  make test           run tests"
	@echo "  make typecheck      tsc --noEmit"
	@echo "  make check          typecheck + test"
	@echo "  make binary         compile a binary for this machine -> build/lasso"
	@echo "  make binaries       cross-compile all targets -> build/"
	@echo "  make install-local  make binary + install to /usr/local/bin"
	@echo "  make release        binaries + sha256 + gh release v$(VERSION)"
	@echo "  make clean          remove dist/ and build/"

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

test:
	npm test

typecheck:
	npm run typecheck

check: typecheck test

binary:
	mkdir -p build
	bun build --compile src/cli.tsx --outfile build/lasso

binaries:
	mkdir -p build
	@for target in $(TARGETS); do \
		echo "Compiling lasso-$$target..."; \
		bun build --compile --target=bun-$$target src/cli.tsx --outfile build/lasso-$$target || exit 1; \
	done
	cd build && shasum -a 256 lasso-* > SHA256SUMS
	@echo ""
	@cat build/SHA256SUMS

install-local: binary
	install -m 755 build/lasso /usr/local/bin/lasso
	@echo "Installed /usr/local/bin/lasso ($(VERSION))"

# Publishes a GitHub release for the current package.json version with the
# cross-compiled binaries attached. Requires a clean tree on main and the
# cby-inc gh account. Prefer pushing a vX.Y.Z tag instead: the release
# workflow builds, releases, and PRs the cowboyinc/homebrew-tap formula.
release: check binaries
	test -z "$$(git status --porcelain)" || (echo "ERROR: working tree is dirty"; exit 1)
	gh release create "v$(VERSION)" \
		build/lasso-darwin-arm64 \
		build/lasso-darwin-x64 \
		build/lasso-linux-x64 \
		build/lasso-linux-arm64 \
		build/SHA256SUMS \
		--title "lasso v$(VERSION)" \
		--generate-notes
	@echo ""
	@echo "Next: update Formula/lasso.rb in cowboyinc/homebrew-lasso with:"
	@cat build/SHA256SUMS

clean:
	rm -rf dist build
