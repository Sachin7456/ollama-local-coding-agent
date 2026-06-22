# Contributing

Thanks for your interest! To propose a change:

1. Fork this repository.
2. Create a branch in your fork.
3. Make your change and open a Pull Request against `main`.
4. All PRs are reviewed by the maintainer. Only the maintainer merges.

Please do not include secrets, credentials, or `.env` files in a PR.
Changes to CI/workflow files and `.gitignore` receive extra scrutiny.

## Before you open a PR

- **The tests must pass** — see the **[Tests](#tests-required-before-every-pr)**
  section below (it also runs a built-in **secret scan** that must stay clean).
- Keep the project **zero-dependency**. Any proposed dependency must be clearly
  justified and security-reviewed first; default to the Node standard library.
- Match the existing style and keep changes focused and behavior-preserving unless
  the PR is specifically about changing behavior.
- **Source lives in feature folders under `src/`** — `cli/`, `model/`, `agent/`,
  `tools/`, `permissions/`, `orchestration/`, `state/`. Put new code in the folder
  that matches its area (the entry point is `src/cli/main.ts`, run via `npm start`).
- Don't commit machine-specific paths, usernames, or anything private.

## Tests (required before every PR)

The project keeps a passing, zero-dependency test suite of **155 tests** under `tests/`,
run by Node's built-in test runner — **no model or network is required** to run it.
`npm test` runs every test file listed in the `"test"` script in `package.json`. Before
you open a PR:

- **Know which tests your change affects.** Find the test file(s) that cover the area
  you touched and update them so they reflect the new behaviour. The suite is grouped
  by area, e.g. `tests/agent.test.ts`, `tests/permissions.test.ts`,
  `tests/tools.test.ts`, `tests/session.test.ts`. If you can't tell what a change
  affects, run the whole suite and see what fails.
- **New feature or bug fix → add a test.** Every new feature (and every fix) must come
  with a test that proves it works. Put the new test in `tests/`, and add the file to
  the `"test"` script in `package.json` so it runs as part of `npm test`.
- **Run the tests and make sure everything passes** before opening the PR. This also
  runs the mandatory secret scan. A PR will not be merged unless `npm test` passes.

### How to run the tests

```bash
# run the whole suite (recommended before every PR)
npm test

# run just one area — see package.json "scripts" for the names (test:m0 … test:m10, etc.)
npm run test:m4

# run a single file directly
node --experimental-strip-types --test tests/your-file.test.ts
```

## Licensing of contributions

By submitting a contribution, you agree that it is licensed under this project's
**Apache License 2.0** (see Section 5 of the [`LICENSE`](./LICENSE)).
