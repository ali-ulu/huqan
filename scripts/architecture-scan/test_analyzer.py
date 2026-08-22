import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("analyzer.py")
SPEC = importlib.util.spec_from_file_location("architecture_analyzer", MODULE_PATH)
analyzer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = analyzer
SPEC.loader.exec_module(analyzer)


class AnalyzerTests(unittest.TestCase):
    def test_sensitive_log_is_critical_without_including_the_value(self):
        findings = analyzer.analyze_file("lib/example.js", 'console.error("token", token);')

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].rule_id, "sensitive-log")
        self.assertEqual(findings[0].severity, "critical")
        self.assertNotIn("token);", findings[0].detail)

    def test_completed_queue_moves_to_next_file_and_cycles(self):
        state = analyzer.new_state()
        files = ["a.js", "b.js"]

        first = analyzer.take_next_file(state, files)
        analyzer.complete_file(state, first)
        second = analyzer.take_next_file(state, files)
        analyzer.complete_file(state, second)
        third = analyzer.take_next_file(state, files)

        self.assertEqual([first, second, third], ["a.js", "b.js", "a.js"])

    def test_requeue_places_failed_file_first_and_counts_attempt(self):
        state = analyzer.new_state()
        state["pending_files"] = ["b.js", "c.js"]

        analyzer.requeue_file(state, "a.js")

        self.assertEqual(state["pending_files"], ["a.js", "b.js", "c.js"])
        self.assertEqual(state["attempts"]["a.js"], 1)

    def test_state_round_trip_preserves_durable_queue(self):
        state = analyzer.new_state()
        state["pending_files"] = ["lib/a.js"]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "state.json"
            analyzer.save_state(path, state)
            restored = analyzer.load_state(path)

        self.assertEqual(restored["pending_files"], ["lib/a.js"])
        self.assertEqual(json.loads(json.dumps(restored))["version"], analyzer.STATE_VERSION)

    def test_state_issue_body_round_trip_preserves_queue(self):
        state = analyzer.new_state()
        state["pending_files"] = ["lib/a.js"]

        body = analyzer.build_state_issue_body(state)
        restored = analyzer.parse_state_issue_body(body)

        self.assertEqual(restored["pending_files"], ["lib/a.js"])
        self.assertIn(analyzer.STATE_MARKER, body)

    def test_fingerprint_is_stable_for_same_finding(self):
        finding = analyzer.Finding("empty-catch", "high", "Fail-closed risk", "detail", 12)

        self.assertEqual(finding.fingerprint("lib/example.js"), finding.fingerprint("lib/example.js"))


if __name__ == "__main__":
    unittest.main()
