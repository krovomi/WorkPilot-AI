"""Which .NET projects a change reaches, how they build, and how two builds pair (lot D)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from rea import ReaLauncher
from rea.dotnet_api import (
    FAIL,
    NONE,
    PASS,
    UNCHECKED,
    DotnetBuilder,
    ProjectOutputs,
    affected_projects,
    cached_outputs,
    compare_outputs,
    dotnet_files,
    pair_tfms,
    projects_in,
    store_outputs,
)
from rea.managed_api import BREAKING, COMPATIBLE, UNKNOWN, ApiChange, ApiDiff

LAUNCHER = ReaLauncher(
    argv=("node", "rea.mjs"),
    source="installed",
    node_version="22.23.4",
    version="6.9.0",
)
PROJECTS = [
    "src/Lib/Lib.csproj",
    "src/Lib.Tests/Lib.Tests.csproj",
    "src/Other/Other.fsproj",
    "tools/App/App.csproj",
]


def test_only_files_that_can_move_an_api_count():
    assert dotnet_files(
        [
            "src/Lib/Api.cs",
            "README.md",
            "src/Other/Lib.fs",
            "Directory.Build.props",
            "global.json",
            ".\\src\\Lib\\Lib.csproj",
            "web/app.ts",
        ]
    ) == [
        "src/Lib/Api.cs",
        "src/Other/Lib.fs",
        "Directory.Build.props",
        "global.json",
        "src/Lib/Lib.csproj",
    ]


def test_the_nearest_project_owns_a_file_and_test_projects_are_left_out():
    assert affected_projects(PROJECTS, ["src/Lib/Deep/Api.cs"]) == [
        "src/Lib/Lib.csproj"
    ]
    assert affected_projects(PROJECTS, ["src/Lib.Tests/ApiTests.cs"]) == []
    assert affected_projects(PROJECTS, ["notes/Script.cs"]) == []
    assert affected_projects(PROJECTS, ["tools/App/App.csproj"]) == [
        "tools/App/App.csproj"
    ]


def test_a_shared_build_file_reaches_every_project():
    assert affected_projects(PROJECTS, ["Directory.Build.props"]) == [
        "src/Lib/Lib.csproj",
        "src/Other/Other.fsproj",
        "tools/App/App.csproj",
    ]
    assert affected_projects(PROJECTS, ["global.json"]) == affected_projects(
        PROJECTS, ["build/Common.targets"]
    )


def test_projects_are_found_outside_build_output(tmp_path):
    for name in (
        "src/Lib/Lib.csproj",
        "src/Lib/bin/Release/Copy.csproj",
        "node_modules/x/X.csproj",
    ):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text("<Project/>", encoding="utf-8")
    assert projects_in(tmp_path) == ["src/Lib/Lib.csproj"]


def test_frameworks_pair_by_name_else_newest_against_newest():
    assert pair_tfms(["net8.0", "net9.0"], ["net9.0", "net10.0"]) == [
        ("net9.0", "net9.0")
    ]
    assert pair_tfms(["net9.0"], ["net10.0"]) == [("net9.0", "net10.0")]
    assert pair_tfms(["netstandard2.0", "net8.0"], ["net10.0", "net48"]) == [
        ("net8.0", "net10.0")
    ]
    assert pair_tfms(["net9.0"], []) == []


class FakeDotnet:
    """``dotnet build`` and MSBuild's ``-getProperty``, answered from a table."""

    def __init__(self, tree: Path, props: dict, *, build_rc: int = 0):
        self.tree, self.props, self.build_rc = tree, props, build_rc
        self.calls: list[list[str]] = []

    def __call__(self, builder, tree, args):
        self.calls.append(list(args))
        if args[0] == "build":
            return subprocess.CompletedProcess(args, self.build_rc, "error CS0103", "")
        names = [a.split(":", 1)[1] for a in args if a.startswith("-getProperty:")]
        tfm = next(
            (a.split("=", 1)[1] for a in args if a.startswith("-p:TargetFramework=")),
            "",
        )
        if names == ["TargetPath"]:
            return subprocess.CompletedProcess(
                args, 0, self.props["paths"].get(tfm, "") + "\n", ""
            )
        return subprocess.CompletedProcess(
            args,
            0,
            json.dumps({"Properties": {n: self.props.get(n, "") for n in names}}),
            "",
        )


def _builder(monkeypatch, fake: FakeDotnet) -> DotnetBuilder:
    monkeypatch.setattr(
        DotnetBuilder, "_run", lambda self, tree, args: fake(self, tree, args)
    )
    return DotnetBuilder("dotnet", timeout=60)


def _tree(tmp_path: Path) -> Path:
    tree = tmp_path / "tree"
    (tree / "src/Lib/bin/Release/net9.0").mkdir(parents=True)
    (tree / "src/Lib/bin/Release/net10.0").mkdir(parents=True)
    (tree / "src/Lib/Lib.csproj").write_text("<Project/>", encoding="utf-8")
    for tfm in ("net9.0", "net10.0"):
        (tree / f"src/Lib/bin/Release/{tfm}/Lib.dll").write_bytes(b"MZ")
    return tree


def test_the_builder_reads_each_framework_from_msbuild(tmp_path, monkeypatch):
    tree = _tree(tmp_path)
    fake = FakeDotnet(
        tree,
        {
            "TargetFrameworks": "net9.0;net10.0",
            "paths": {
                tfm: str(tree / f"src/Lib/bin/Release/{tfm}/Lib.dll")
                for tfm in ("net9.0", "net10.0")
            },
        },
    )
    built = _builder(monkeypatch, fake)(tree, "src/Lib/Lib.csproj")
    assert built.library and not built.error
    assert sorted(built.outputs) == ["net10.0", "net9.0"]
    assert fake.calls[0][:4] == ["build", "src/Lib/Lib.csproj", "-c", "Release"]


def test_the_builder_refuses_what_is_not_a_library_or_outside_the_tree(
    tmp_path, monkeypatch
):
    tree = _tree(tmp_path)
    assert not _builder(
        monkeypatch, FakeDotnet(tree, {"OutputType": "Exe", "paths": {}})
    )(tree, "src/Lib/Lib.csproj").library
    assert not _builder(
        monkeypatch, FakeDotnet(tree, {"IsTestProject": "true", "paths": {}})
    )(tree, "src/Lib/Lib.csproj").library
    outside = tmp_path / "elsewhere.dll"
    outside.write_bytes(b"MZ")
    escaped = _builder(
        monkeypatch,
        FakeDotnet(
            tree, {"TargetFramework": "net9.0", "paths": {"net9.0": str(outside)}}
        ),
    )(tree, "src/Lib/Lib.csproj")
    assert escaped.error.startswith("no assembly for net9.0")
    failed = _builder(monkeypatch, FakeDotnet(tree, {"paths": {}}, build_rc=1))(
        tree, "src/Lib/Lib.csproj"
    )
    assert "dotnet build failed" in failed.error and "CS0103" in failed.error
    assert "not in the tree" in DotnetBuilder("dotnet")(tree, "-p:Evil=1").error


def _api(status: str, *breaking: ApiChange, unknown: str = "") -> ApiDiff:
    return ApiDiff(
        status=status, breaking=list(breaking), unknown=unknown, public_members=3
    )


def _compare(
    before, after, projects, api: ApiDiff | None = None, seen: list | None = None
):
    def fake(left, right, **_):
        if seen is not None:
            seen.append((left.name, right.name))
        return api or _api(COMPATIBLE)

    return compare_outputs(before, after, projects, launcher=LAUNCHER, diff=fake)


LIB = ProjectOutputs(library=True, outputs={"net9.0": "/a/Lib.dll"})
LIB10 = ProjectOutputs(library=True, outputs={"net10.0": "/b/Lib10.dll"})


def test_a_retargeted_library_is_compared_newest_to_newest():
    seen: list = []
    report = _compare({"L.csproj": LIB}, {"L.csproj": LIB10}, ["L.csproj"], seen=seen)
    assert report.status == PASS and seen == [("Lib.dll", "Lib10.dll")]
    assert (report.assemblies[0].before, report.assemblies[0].after) == (
        "net9.0",
        "net10.0",
    )
    assert report.rea == "rea-agents 6.9.0 (installed)"


def test_a_break_fails_and_an_unknown_is_never_a_pass():
    report = _compare(
        {"L.csproj": LIB},
        {"L.csproj": LIB},
        ["L.csproj"],
        _api(BREAKING, ApiChange("removed", "Lib.Api.Run")),
    )
    assert report.status == FAIL
    assert [(a.project, c["member"]) for a, c in report.blocking] == [
        ("L.csproj", "Lib.Api.Run")
    ]
    report = _compare(
        {"L.csproj": LIB},
        {"L.csproj": LIB},
        ["L.csproj"],
        _api(UNKNOWN, unknown="REA's comparison is partial"),
    )
    assert report.status == UNCHECKED and "partial" in report.unchecked


def test_a_build_that_fails_on_either_side_is_unchecked():
    failed = ProjectOutputs(error="dotnet build failed: CS0103")
    report = _compare({"L.csproj": failed}, {"L.csproj": LIB}, ["L.csproj"])
    assert report.status == UNCHECKED and "at the base" in report.unchecked
    report = _compare({"L.csproj": LIB}, {"L.csproj": failed}, ["L.csproj"])
    assert report.status == UNCHECKED and "CS0103" in report.unchecked


def test_a_removed_library_breaks_and_a_new_one_is_noted():
    report = _compare({"L.csproj": LIB}, {}, ["L.csproj"])
    assert (
        report.status == FAIL and report.assemblies[0].breaking[0]["kind"] == "removed"
    )
    report = _compare({}, {"N.csproj": LIB}, ["N.csproj"])
    assert report.status == NONE and "N.csproj is new" in report.notes[0]
    report = _compare(
        {"A.csproj": ProjectOutputs(library=False)}, {"A.csproj": LIB}, ["A.csproj"]
    )
    assert report.status == NONE


def test_base_builds_are_kept_and_read_back(tmp_path):
    dll = tmp_path / "copy" / "Lib.dll"
    dll.parent.mkdir()
    dll.write_bytes(b"MZ")
    cache = tmp_path / "cache"
    kept = store_outputs(
        cache,
        "src/Lib/Lib.csproj",
        ProjectOutputs(library=True, outputs={"net9.0": str(dll)}),
    )
    dll.unlink()  # the copy it came from is gone
    found = cached_outputs(cache, "src/Lib/Lib.csproj")
    assert found is not None and found.outputs == kept.outputs
    assert Path(found.outputs["net9.0"]).read_bytes() == b"MZ"
    assert cached_outputs(cache, "other.csproj") is None
    store_outputs(cache, "bad.csproj", ProjectOutputs(error="dotnet build failed"))
    assert cached_outputs(cache, "bad.csproj") is None  # a failure is retried
    index = json.loads((cache / "index.json").read_text(encoding="utf-8"))
    index["src/Lib/Lib.csproj"]["outputs"]["net9.0"] = "../../outside.dll"
    (cache / "index.json").write_text(json.dumps(index), encoding="utf-8")
    assert cached_outputs(cache, "src/Lib/Lib.csproj") is None
