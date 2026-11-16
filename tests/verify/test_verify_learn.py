"""What a verification leaves for the next one: recipe, baseline, brain, gotchas.

All of it is written to real files: the project's `.workpilot/verify/`, and a
brain vault in a temporary folder (`WORKPILOT_BRAIN_DIR`) that the project
memory creates on its first write, as it does on a person's machine.
"""

from __future__ import annotations

import json

import pytest
from verify.learn import (
    _brain_body,
    compare_baseline,
    load_baseline,
    load_recipe,
    record_gotchas,
    record_in_brain,
    save_recipe,
    update_baseline,
)


def _target(
    name, status="ready", errors=(), template="npm run dev -- --port {port}", **extra
):
    return {
        "name": name,
        "kind": "web-frontend",
        "root": ".",
        "launch": {"status": status},
        "errors": list(errors),
        "command_template": template,
        "env_names": ["PORT", "BROWSER"],
        **extra,
    }


def test_only_a_clean_launch_is_learned(tmp_path):
    record = {
        "targets": [
            _target("web", notes=["needs node 20"]),
            _target("api", status="reused", ready_path="/health"),
            _target("worker", status="timeout"),
            _target("admin", errors=[{"kind": "build", "message": "x"}]),
            _target("docs", template=""),
        ]
    }

    learned = save_recipe(tmp_path, record)

    assert set(learned) == {"web", "api"}
    recipe = load_recipe(tmp_path)
    assert recipe["web"]["command"] == "npm run dev -- --port {port}"
    assert recipe["web"]["env_names"] == ["BROWSER", "PORT"]
    assert recipe["web"]["notes"] == ["needs node 20"]
    assert recipe["api"]["ready_path"] == "/health"
    assert "notes" not in recipe["api"]


def test_a_new_recipe_keeps_the_targets_it_did_not_relaunch(tmp_path):
    save_recipe(tmp_path, {"targets": [_target("web")]})
    save_recipe(tmp_path, {"targets": [_target("api", template="dotnet run")]})
    assert set(load_recipe(tmp_path)) == {"web", "api"}


def test_nothing_learned_writes_nothing(tmp_path):
    assert save_recipe(tmp_path, {"targets": [_target("web", status="crashed")]}) == {}
    assert not (tmp_path / ".workpilot" / "verify" / "recipe.json").exists()
    assert load_recipe(tmp_path) == {}


def test_a_recipe_file_that_is_not_a_map_is_ignored(tmp_path):
    path = tmp_path / ".workpilot" / "verify" / "recipe.json"
    path.parent.mkdir(parents=True)
    path.write_text("[1, 2]", encoding="utf-8")
    assert load_recipe(tmp_path) == {}
    path.write_text(json.dumps({"targets": [1]}), encoding="utf-8")
    assert save_recipe(tmp_path, {"targets": [_target("web")]})
    assert set(load_recipe(tmp_path)) == {"web"}


def test_a_recipe_that_cannot_be_written_does_not_raise(tmp_path):
    (tmp_path / ".workpilot").write_text("a file, not a folder", encoding="utf-8")
    assert set(save_recipe(tmp_path, {"targets": [_target("web")]})) == {"web"}
    assert load_recipe(tmp_path) == {}


def _perf(url, score, lcp=1200.0):
    return {"url": url, "score": score, "lcp_ms": lcp, "cls": 0.0}


def test_a_page_that_got_slower_than_its_best_recent_score_is_a_finding(tmp_path):
    for score in (70, 92, 88):
        update_baseline(
            tmp_path, [_perf("http://127.0.0.1:5173/orders?x=1", score)], "s"
        )
    assert [h["score"] for h in load_baseline(tmp_path)["/orders"]] == [70, 92, 88]

    findings = compare_baseline(
        tmp_path,
        [
            _perf("http://127.0.0.1:4000/orders", 80),
            _perf("http://127.0.0.1:4000/new-page", 10),
            {"url": "http://127.0.0.1:4000/orders", "score": None},
        ],
        threshold=10,
    )
    assert findings == [
        {
            "severity": "medium",
            "kind": "perf-regression",
            "message": "performance of /orders fell from 92 to 80 (threshold 10)",
        }
    ]
    assert compare_baseline(tmp_path, [_perf("http://h/orders", 85)], 10) == []


def test_the_baseline_keeps_the_last_twenty_measures(tmp_path):
    for score in range(25):
        update_baseline(tmp_path, [_perf("http://h/", score)], f"spec-{score}")
    history = load_baseline(tmp_path)["/"]
    assert len(history) == 20
    assert history[0]["spec"] == "spec-5" and history[-1]["score"] == 24


def test_an_unscored_page_does_not_touch_the_baseline(tmp_path):
    update_baseline(tmp_path, [{"url": "http://h/", "score": None}], "s")
    assert not (tmp_path / ".workpilot" / "verify" / "baseline.json").exists()


def test_a_url_that_does_not_parse_is_the_root(tmp_path):
    update_baseline(tmp_path, [_perf("http://[::1/broken", 50)], "s")
    assert list(load_baseline(tmp_path)) == ["/"]


RECORD = {
    "status": "pass",
    "reason": "all checks passed",
    "score": 91,
    "targets": [
        {
            "name": "api",
            "kind": "backend-api",
            "command_template": "uvicorn main:app --port {port}",
            "launch": {"status": "ready"},
        },
        {
            "name": "web",
            "kind": "web-frontend",
            "launch": {"status": "ready", "command": "npm run dev"},
        },
    ],
    "rounds": [
        {
            "fixed": True,
            "errors_before": 2,
            "errors_after": 0,
            "note": "Set the default DB URL.",
            "errors": [
                {"message": "settings: ORDERS_DB is not configured"},
                {"message": " "},
            ],
        },
        {"fixed": False, "errors": [{"message": "still broken"}]},
    ],
    "confirmations": [{"state": "order 2 created"}],
    "endpoints": [{"ok": True}, {"ok": False}],
    "findings": [{"severity": "medium", "message": "LCP regressed"}],
}


def test_the_brain_note_states_what_was_measured():
    body = _brain_body(RECORD)
    assert body.startswith("_Données mesurées par la boucle de vérification")
    for line in (
        "- Verdict : **pass** — all checks passed",
        "- Score : 91/100",
        "- `api` (backend-api) lancé par `uvicorn main:app --port {port}` → ready",
        "- `web` (web-frontend) lancé par `npm run dev` → ready",
        "- Tours de correction : 2 (2 → None erreur(s))",
        "- État confirmé : order 2 created",
        "- Endpoints : 1/2 conformes",
        "- [medium] LCP regressed",
    ):
        assert line in body.splitlines(), line
    assert (
        _brain_body({"status": "unknown"}).splitlines()[-1] == "- Verdict : **unknown**"
    )


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    project = tmp_path / "shop"
    spec = project / ".workpilot" / "specs" / "001-orders"
    spec.mkdir(parents=True)
    return root, project, spec


def test_a_launch_failure_a_round_fixed_becomes_a_gotcha(vault):
    root, _project, spec = vault
    assert record_gotchas(spec, RECORD) == 1
    notes = list((root / "knowledge").rglob("*.md"))
    text = "\n".join(p.read_text(encoding="utf-8") for p in notes)
    assert (
        "Au lancement de l'application : settings: ORDERS_DB is not configured" in text
    )
    assert "still broken" not in text


def test_no_gotcha_without_a_spec_a_fixed_round_or_memory(vault, monkeypatch):
    _root, _project, spec = vault
    assert record_gotchas(None, RECORD) == 0
    assert record_gotchas(spec, {"rounds": [{"fixed": False}]}) == 0
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    assert record_gotchas(spec, RECORD) == 0


def test_a_memory_that_fails_costs_the_gotcha_not_the_verification(vault, monkeypatch):
    _root, _project, spec = vault
    import memory.store as store

    def broken(spec_dir, write):
        raise OSError("vault is read-only")

    monkeypatch.setattr(store, "remember", broken)
    assert record_gotchas(spec, RECORD) == 0


def test_each_verification_is_a_note_in_the_brain(vault):
    root, project, spec = vault
    # The project memory creates the vault on its first write.
    record_gotchas(spec, RECORD)

    rel = record_in_brain(project, spec, RECORD)

    assert rel is not None
    note = (root / rel).read_text(encoding="utf-8")
    assert "Vérification 001-orders — pass" in note
    assert "- Score : 91/100" in note
    manual = record_in_brain(project, None, {"status": "fail"})
    assert manual is not None
    assert "Vérification manual — fail" in (root / manual).read_text(encoding="utf-8")


def test_without_a_brain_no_note_is_written(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "none"))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    assert record_in_brain(tmp_path, None, RECORD) is None

    import brain.learn as brain_learn

    def broken(*args, **kwargs):
        raise RuntimeError("index corrupted")

    monkeypatch.setattr(brain_learn, "record", broken)
    assert record_in_brain(tmp_path, None, RECORD) is None
