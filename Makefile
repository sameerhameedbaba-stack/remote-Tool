# Remote Support MVP — unified developer task runner.
#
# One entry point across the three stacks (Rust agent, Go backend, Next.js
# console) so a new contributor does not need to know each toolchain's commands.
# CI (.github/workflows/ci.yml) runs the same underlying checks.
#
#   make install     fetch/download all deps
#   make build       build all three stacks
#   make test        run the full test suite (test/run-all.sh)
#   make smoke-test   quick backend+integration smoke (test/run-all.sh --quick)
#   make lint        clippy -D warnings + go vet + eslint
#   make typecheck   cargo check + go build + tsc --noEmit
#   make format      cargo fmt + gofmt -w + eslint --fix
#   make clean       remove build artifacts

.DEFAULT_GOAL := help
.PHONY: help install build test smoke-test lint typecheck format clean \
        build-agent build-backend build-web

AGENT   := agent-rust
BACKEND := backend-go
WEB     := web-console

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

install: ## Fetch/download dependencies for all stacks
	cd $(AGENT)   && cargo fetch
	cd $(BACKEND) && go mod download
	cd $(WEB)     && npm ci

build: build-agent build-backend build-web ## Build all three stacks

build-agent:
	cd $(AGENT) && cargo build

build-backend:
	cd $(BACKEND) && go build ./...

build-web:
	cd $(WEB) && npm run build

test: ## Run the full test suite (unit + integration + e2e)
	bash test/run-all.sh

smoke-test: ## Fast smoke test (skips the heavy browser e2e)
	bash test/run-all.sh --quick

lint: ## Lint all stacks (clippy -D warnings, go vet, eslint)
	cd $(AGENT)   && cargo clippy --all-targets -- -D warnings
	cd $(BACKEND) && go vet ./...
	cd $(WEB)     && npm run lint

typecheck: ## Type-check all stacks without producing artifacts
	cd $(AGENT)   && cargo check --all-targets
	cd $(BACKEND) && go build ./...
	cd $(WEB)     && npx tsc --noEmit

format: ## Auto-format all stacks
	cd $(AGENT)   && cargo fmt
	cd $(BACKEND) && gofmt -w .
	cd $(WEB)     && npm run lint -- --fix || true

clean: ## Remove build artifacts
	rm -rf $(AGENT)/target $(BACKEND)/bin $(BACKEND)/tmp $(WEB)/.next $(WEB)/out
	find . -name '*.tsbuildinfo' -delete
