"""Run one unittest suite and fail if any test failed, errored or was SKIPPED.

For the CI job that installs cadquery: every skip in verify/ and model/ is a "no cadquery"
skip, so with cadquery installed a skip means the executed-geometry tests did not run.

    python .github/scripts/unittest_no_skips.py verify/verifiers/tests

Run it once per suite (each in its own process), as `python -m unittest discover -s DIR`
would, so suites cannot leak sys.path entries or modules into each other.
"""
import sys
import unittest


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    start = sys.argv[1]
    suite = unittest.defaultTestLoader.discover(start_dir=start)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.testsRun == 0:
        print(f"\n{start}: no tests ran", file=sys.stderr)
        return 1
    if result.skipped:
        print(f"\n{start}: {len(result.skipped)} test(s) skipped; this job requires none:",
              file=sys.stderr)
        for test, reason in result.skipped:
            print(f"  {test.id()}: {reason}", file=sys.stderr)
        return 1
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
