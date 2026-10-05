# Thin wrapper around the npm scripts: the npm scripts are the single definition, this
# file repeats nothing, so it cannot drift from what CI runs.
.DEFAULT_GOAL := help
.PHONY: help setup summary baseline check delta test lint typecheck fmt-check ci

help: ## show this help
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## install dependencies
	npm ci

summary: ## what each fixture run did
	npm run --silent traceset -- summary fixtures/baseline.jsonl fixtures/pricier.jsonl fixtures/worse.jsonl

baseline: ## freeze the fixtures as the baseline, on purpose: this is the demo
	npm run --silent traceset -- baseline fixtures/baseline.jsonl --out traceset.baseline.json

check: ## the regression gate: exit 1 if a run got worse
	npm run --silent traceset -- check fixtures/pricier.jsonl fixtures/worse.jsonl

test: ## full suite
	npm test

typecheck: ## strict types
	npm run typecheck

lint: ## eslint, zero warnings tolerated
	npm run lint

ci: ## exactly what runs in CI
	npm run ci
