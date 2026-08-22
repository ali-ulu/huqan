#!/usr/bin/env python3
"""Deterministic, one-file HUQAN architecture scanner for GitHub Actions.

The scanner persists its queue in a JSON file, evaluates one source file per
invocation, and opens a GitHub issue only when a finding's stable fingerprint
does not already appear in an open issue. It deliberately stores no source
snippets in issue bodies, because a finding could be related to a secret.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


CORE_FILES = {"kernel.js", "kernel.v2.js", "graph.js", "server.js", "cli.js", "mcpServer.js"}
DEFAULT_STATE_PATH = ".huqan_automation_state.json"
STATE_VERSION = 2
STATE_MARKER = "huqan-scan-state:v2"
STATE_ISSUE_TITLE = "[HUQAN Scan] Queue State"


@dataclass(frozen=True)
class Finding:
    rule_id: str
    severity: str
    summary: str
    detail: str
    line: int | None = None

    def fingerprint(self, file_path: str) -> str:
        source = f"{file_path}|{self.rule_id}|{self.line or 0}|{self.summary}".encode("utf-8")
        return hashlib.sha256(source).hexdigest()[:20]


class GitHubIssueError(RuntimeError):
    """A GitHub issue could not be queried or created."""


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def line_number(content: str, offset: int) -> int:
    return content.count("\n", 0, offset) + 1


def new_state() -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "pending_files": [],
        "completed_files": [],
        "attempts": {},
        "issues": {},
        "last_run": None,
    }


def load_state(state_path: Path) -> dict[str, Any]:
    if not state_path.exists():
        return new_state()
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Tarama kuyruğu okunamadı: {error}") from error

    for key, default in new_state().items():
        state.setdefault(key, default)
    if state.get("version") != STATE_VERSION:
        state["version"] = STATE_VERSION
    return state


def save_state(state_path: Path, state: dict[str, Any]) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = state_path.with_suffix(f"{state_path.suffix}.tmp")
    temporary_path.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary_path.replace(state_path)


def build_state_issue_body(state: dict[str, Any]) -> str:
    return f"""<!-- {STATE_MARKER} -->
## HUQAN mimari tarama kuyruğu

Bu issue, saatlik mimari tarama iş akışının makine tarafından yönetilen kalıcı durumudur. Lütfen bu issue'yu kapatmayın veya gövdesindeki JSON verisini elle değiştirmeyin.

```json
{json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True)}
```
"""


def parse_state_issue_body(body: str) -> dict[str, Any]:
    if STATE_MARKER not in body:
        raise RuntimeError("Tarama durumu issue gövdesinde gerekli işaretleyici bulunamadı.")
    match = re.search(r"```json\s*(\{.*?\})\s*```", body, re.DOTALL)
    if not match:
        raise RuntimeError("Tarama durumu issue gövdesinde JSON verisi bulunamadı.")
    try:
        state = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Tarama durumu JSON verisi geçersiz: {error}") from error
    for key, default in new_state().items():
        state.setdefault(key, default)
    state["version"] = STATE_VERSION
    return state


def source_files(repo_dir: Path) -> list[str]:
    candidates: list[Path] = []
    candidates.extend(repo_dir.glob("*.js"))
    lib_dir = repo_dir / "lib"
    if lib_dir.exists():
        candidates.extend(lib_dir.rglob("*.js"))

    return sorted(
        path.relative_to(repo_dir).as_posix()
        for path in candidates
        if not path.name.endswith(".test.js") and "node_modules" not in path.parts
    )


def ensure_queue(state: dict[str, Any], files: list[str]) -> None:
    available = set(files)
    state["pending_files"] = [path for path in state["pending_files"] if path in available]
    state["completed_files"] = [path for path in state["completed_files"] if path in available]

    if state["pending_files"]:
        return

    completed = set(state["completed_files"])
    remaining = [path for path in files if path not in completed]
    if remaining:
        state["pending_files"] = remaining
        return

    state["pending_files"] = files[:]
    state["completed_files"] = []


def take_next_file(state: dict[str, Any], files: list[str]) -> str:
    ensure_queue(state, files)
    if not state["pending_files"]:
        raise RuntimeError("Taranacak kaynak dosyası bulunamadı.")
    return state["pending_files"].pop(0)


def requeue_file(state: dict[str, Any], file_path: str) -> None:
    state["pending_files"] = [path for path in state["pending_files"] if path != file_path]
    state["pending_files"].insert(0, file_path)
    state["attempts"][file_path] = int(state["attempts"].get(file_path, 0)) + 1


def complete_file(state: dict[str, Any], file_path: str) -> None:
    if file_path not in state["completed_files"]:
        state["completed_files"].append(file_path)
    state["attempts"].pop(file_path, None)


def analyze_file(file_path: str, content: str) -> list[Finding]:
    """Apply the deterministic HUQAN review rules without retaining source data."""
    findings: list[Finding] = []

    sensitive_log = re.search(
        r"console\.(?:log|warn|error)\([^\n]*(?:password|secret|token|api[_-]?key|credential)[^\n]*\)",
        content,
        re.IGNORECASE,
    )
    if sensitive_log:
        findings.append(
            Finding(
                "sensitive-log",
                "critical",
                "Hassas değer günlük çıktısına taşınabilir",
                "Bir log çağrısında şifre, token, anahtar veya kimlik bilgisiyle ilişkili bir değer tespit edildi.",
                line_number(content, sensitive_log.start()),
            )
        )

    hardcoded_secret = re.search(
        r"\b(?:password|secret|token|api[_-]?key|credential)\b\s*[:=]\s*['\"][^'\"\n]{12,}['\"]",
        content,
        re.IGNORECASE,
    )
    if hardcoded_secret:
        findings.append(
            Finding(
                "hardcoded-secret",
                "critical",
                "Sabit kodlanmış hassas değer riski",
                "Hassas anahtar sözcükle adlandırılmış bir değişkene uzun bir literal atanmış görünüyor. Değer issue gövdesine yazılmadı.",
                line_number(content, hardcoded_secret.start()),
            )
        )

    empty_catch = re.search(r"catch\s*\([^)]*\)\s*\{\s*\}", content)
    if empty_catch:
        findings.append(
            Finding(
                "empty-catch",
                "high",
                "Fail-closed davranışı zayıflatabilecek boş catch bloğu",
                "Hata yakalanıyor fakat güvenli hata durumu, yeniden fırlatma veya açık bir escalation görünmüyor.",
                line_number(content, empty_catch.start()),
            )
        )

    direct_write = re.search(r"\b(?:db|store)\.(?:run|exec|insert|update)\s*\(", content)
    has_gate_language = re.search(r"\b(?:gate|admission|approve|approval|policy|risk)\b", content, re.IGNORECASE)
    if direct_write and not has_gate_language:
        findings.append(
            Finding(
                "unguarded-write",
                "high",
                "Admission veya policy görünmeden doğrudan yazma çağrısı",
                "Dosya, yerel bağlamda approval/admission/policy/risk kontrolü görünmeden doğrudan depolama yazma çağrısı yapıyor.",
                line_number(content, direct_write.start()),
            )
        )

    if Path(file_path).name in CORE_FILES and len(content.splitlines()) > 2200:
        findings.append(
            Finding(
                "core-boundary-size",
                "medium",
                "Çekirdek dosya sorumluluk sınırını aşmış olabilir",
                "Çekirdek dosya 2.200 satırı aşıyor. Yeni domain mantığının daha küçük delegasyon modüllerine ayrılıp ayrılmadığı gözden geçirilmeli.",
            )
        )

    return findings


def run_gh(arguments: list[str]) -> str:
    result = subprocess.run(["gh", *arguments], text=True, capture_output=True, check=False)
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "Bilinmeyen gh hatası"
        raise GitHubIssueError(message)
    return result.stdout


def load_github_state() -> tuple[dict[str, Any], int]:
    output = run_gh([
        "issue", "list", "--state", "open", "--search", STATE_MARKER,
        "--json", "number,body", "--limit", "100",
    ])
    try:
        issues = json.loads(output)
    except json.JSONDecodeError as error:
        raise GitHubIssueError(f"GitHub tarama durumu yanıtı çözümlenemedi: {error}") from error

    for issue in issues:
        if STATE_MARKER in (issue.get("body") or ""):
            return parse_state_issue_body(issue["body"]), int(issue["number"])

    state = new_state()
    body = build_state_issue_body(state)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".md", delete=False) as temporary:
        temporary.write(body)
        body_path = temporary.name
    try:
        url = run_gh(["issue", "create", "--title", STATE_ISSUE_TITLE, "--body-file", body_path]).strip()
    finally:
        Path(body_path).unlink(missing_ok=True)

    issue_number = int(url.rstrip("/").split("/")[-1])
    return state, issue_number


def save_github_state(issue_number: int, state: dict[str, Any]) -> None:
    body = build_state_issue_body(state)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".md", delete=False) as temporary:
        temporary.write(body)
        body_path = temporary.name
    try:
        run_gh(["issue", "edit", str(issue_number), "--body-file", body_path])
    finally:
        Path(body_path).unlink(missing_ok=True)


def find_open_issue(fingerprint: str) -> str | None:
    marker = f"huqan-scan:{fingerprint}"
    output = run_gh([
        "issue", "list", "--state", "open", "--search", marker,
        "--json", "body,url", "--limit", "100",
    ])
    try:
        issues = json.loads(output)
    except json.JSONDecodeError as error:
        raise GitHubIssueError(f"GitHub issue yanıtı çözümlenemedi: {error}") from error

    for issue in issues:
        if marker in (issue.get("body") or ""):
            return issue.get("url")
    return None


def build_issue_body(file_path: str, finding: Finding, fingerprint: str) -> str:
    source_revision = os.environ.get("GITHUB_SHA", "bilinmiyor")
    line = f"{finding.line}. satır" if finding.line else "Dosya seviyesi"
    return f"""## Otomatik HUQAN mimari taraması

| Alan | Değer |
| --- | --- |
| Dosya | `{file_path}` |
| Kural | `{finding.rule_id}` |
| Önem | **{finding.severity.upper()}** |
| Konum | {line} |
| Kaynak revizyon | `{source_revision}` |

{finding.detail}

Bu bulgu deterministik denetim tarafından oluşturuldu. Yanlış pozitif ise inceleme sonrasında issue kapatılmalıdır. Olası hassas kaynak değeri issue gövdesine kopyalanmaz.

<!-- huqan-scan:{fingerprint} -->
"""


def create_issue(file_path: str, finding: Finding) -> tuple[str, str]:
    fingerprint = finding.fingerprint(file_path)
    existing_url = find_open_issue(fingerprint)
    if existing_url:
        return "existing", existing_url

    title = f"[HUQAN Scan][{finding.severity.upper()}] {finding.summary} — {file_path}"
    body = build_issue_body(file_path, finding, fingerprint)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".md", delete=False) as temporary:
        temporary.write(body)
        body_path = temporary.name

    try:
        issue_url = run_gh(["issue", "create", "--title", title, "--body-file", body_path]).strip()
    finally:
        Path(body_path).unlink(missing_ok=True)

    return "created", issue_url


def scan_once(repo_dir: Path, state: dict[str, Any], persist_state: Any) -> dict[str, Any]:
    files = source_files(repo_dir)
    file_path = take_next_file(state, files)
    absolute_path = repo_dir / file_path
    report: dict[str, Any] = {
        "timestamp": now_iso(),
        "file": file_path,
        "created_issues": [],
        "existing_issues": [],
        "findings": [],
        "status": "started",
    }

    try:
        content = absolute_path.read_text(encoding="utf-8")
        findings = analyze_file(file_path, content)
        report["findings"] = [asdict(finding) for finding in findings]

        for finding in findings:
            status, issue_url = create_issue(file_path, finding)
            if status == "created":
                report["created_issues"].append(issue_url)
            else:
                report["existing_issues"].append(issue_url)

        complete_file(state, file_path)
        report["status"] = "completed"
        state["last_run"] = report
        persist_state(state)
        return report
    except Exception as error:
        requeue_file(state, file_path)
        report["status"] = "failed"
        report["error"] = str(error)
        state["last_run"] = report
        persist_state(state)
        raise


def main() -> int:
    repo_dir = Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()
    state_path = Path(os.environ.get("STATE_FILE_PATH", DEFAULT_STATE_PATH)).resolve()
    try:
        if os.environ.get("STATE_BACKEND") == "github":
            state, issue_number = load_github_state()
            report = scan_once(repo_dir, state, lambda value: save_github_state(issue_number, value))
        else:
            state = load_state(state_path)
            report = scan_once(repo_dir, state, lambda value: save_state(state_path, value))
    except Exception as error:
        print(f"HUQAN taraması başarısız: {error}", file=sys.stderr)
        return 1

    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
