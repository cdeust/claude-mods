# Python CI helper coverage

The unit command preserves `claude plugin validate mods/delegate` and `claude plugin test mods/delegate` with Claude Code 2.1.306. It then runs the Python CI helper tests under hash-locked coverage.py 7.15.2 and writes the real Cobertura report to `coverage.xml`. The existing pipeline floor remains 90 percent.

`.coveragerc` measures production Python CI review helpers under `scripts/`; it excludes `scripts/tests/`. Application coverage for the TypeScript hooks in `mods/delegate/hooks/` is N/A. The existing native plugin tests run independently of this Python coverage measurement.

Verification of the final unit command preserved all 27 native plugin tests. The Python suite passed 172 tests, including the existing source216 contracts and the added upstream Cortex safety tests. The measured report covers 936 of 1,024 Python CI helper lines, or 91.41 percent. It contains no TypeScript application coverage result.

The added tests retain their pinned Cortex source URLs. They exercise authenticated review evidence, editor attribution, security resolution and CLI boundaries. The standalone exported workflow authorization contract also passed all 12 tests with third-party site packages disabled.
