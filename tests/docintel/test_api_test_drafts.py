"""Integration-test drafts from an HTTP capture, in every variant of each stack.

`test_docintel_code.py` drafts one POST with a JSON body in each backend
stack. This file drafts what else a capture holds — no body, a body that is
not JSON, a content type of its own — in the variants a project chooses:
NUnit or Shouldly, Flask, a Node project without supertest. Then where the
draft goes when the layout cannot say, and a project whose stack or libraries
cannot be read: a draft is a suggestion, so none of that is an error.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from docintel import api_tests
from docintel.api_capture import PLACEHOLDER, ApiExchange
from docintel.api_tests import api_tests_section, draft_test, find_handler
from docintel.models import DocintelResult, ExtractedDocument


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def exchange(method="GET", path="/api/orders", body="", headers=None, status=None):
    return ApiExchange(
        method=method,
        path=path,
        headers=headers or {},
        body=body,
        status=status,
        origin="http-file",
        source="calls.http",
    )


def aspnet(root: Path, *packages: str) -> Path:
    write(
        root, "src/Shop.Api/Shop.Api.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web"/>'
    )
    refs = "".join(
        f'<PackageReference Include="{p}" Version="1.0.0" />' for p in packages
    )
    write(
        root,
        "tests/Shop.Api.Tests/Shop.Api.Tests.csproj",
        f'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>{refs}</ItemGroup></Project>',
    )
    return root


TEXT_BODY = exchange(
    "POST", "/api/notes", "plain words", {"Content-Type": "text/plain"}
)


class TestDotnet:
    def test_nunit_and_shouldly_are_written_in_their_own_idiom(self, tmp_path):
        root = aspnet(tmp_path, "NUnit", "Shouldly")

        draft = draft_test(root, exchange(status=404))

        assert "[OneTimeSetUp]" in draft.code and "[Test]" in draft.code
        assert "using Shouldly;" in draft.code
        assert "response.StatusCode.ShouldBe(HttpStatusCode.NotFound);" in draft.code

    def test_nunit_alone_asserts_with_assert_that(self, tmp_path):
        root = aspnet(tmp_path, "NUnit")

        code = draft_test(root, exchange()).code

        assert (
            "Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));" in code
        )

    def test_a_body_that_is_not_json_is_sent_as_it_is(self, tmp_path):
        code = draft_test(aspnet(tmp_path, "xunit"), TEXT_BODY).code

        assert 'new StringContent(@"plain words", Encoding.UTF8, "text/plain")' in code

    def test_the_draft_goes_beside_the_test_project_it_names(self, tmp_path):
        root = aspnet(tmp_path, "xunit")

        target = root / "tests" / "Shop.Api.Tests" / "OrdersApiTests.cs"

        assert api_tests._into_test_project(target) == target

    def test_a_folder_that_cannot_be_listed_keeps_the_proposed_path(
        self, tmp_path, monkeypatch
    ):
        target = tmp_path / "tests" / "OrdersApiTests.cs"
        target.parent.mkdir()
        real = Path.glob

        def glob(self, pattern):
            if pattern == "*/*.csproj":
                raise PermissionError(self)
            return real(self, pattern)

        monkeypatch.setattr(Path, "glob", glob)

        assert api_tests._into_test_project(target) == target


class TestPython:
    def test_flask_without_a_body_uses_the_app_factory(self, tmp_path):
        write(tmp_path, "requirements.txt", "flask\npytest\n")

        draft = draft_test(tmp_path, exchange(status=200))

        assert "return create_app().test_client()" in draft.code
        assert "import json" not in draft.code and "BODY" not in draft.code
        assert 'response = client.get("/api/orders")' in draft.code

    @pytest.mark.parametrize(
        ("framework", "argument"),
        [("fastapi", "content=BODY"), ("flask", "data=BODY")],
    )
    def test_a_body_that_is_not_json_is_sent_as_text(
        self, tmp_path, framework, argument
    ):
        write(tmp_path, "requirements.txt", f"{framework}\npytest\n")

        code = draft_test(tmp_path, TEXT_BODY).code

        assert 'BODY = "plain words"' in code and argument in code
        assert "import json" not in code


class TestNodeSpringGo:
    def test_node_without_supertest_says_how_to_add_it(self, tmp_path):
        write(tmp_path, "package.json", '{"dependencies": {"express": "4"}}')

        draft = draft_test(tmp_path, TEXT_BODY)

        assert '.set("Content-Type", "text/plain").send("plain words")' in draft.code
        assert any("supertest is not a dependency yet" in n for n in draft.notes)

    def test_node_without_a_body_sends_none(self, tmp_path):
        write(tmp_path, "package.json", '{"dependencies": {"express": "4"}}')

        code = draft_test(tmp_path, exchange()).code

        assert ".send(" not in code

    def test_spring_and_go_without_a_body_set_no_content(self, tmp_path):
        spring = tmp_path / "spring"
        write(spring, "pom.xml", "<project>spring-boot-starter-web</project>")
        go = tmp_path / "go"
        write(go, "go.mod", "module example.com/shop\n")

        spring_code = draft_test(spring, exchange()).code
        go_code = draft_test(go, exchange()).code

        assert ".contentType(" not in spring_code
        assert '"strings"' not in go_code and "Content-Type" not in go_code
        assert 'httptest.NewRequest("GET", "/api/orders", nil)' in go_code


class TestHandler:
    def test_a_route_without_a_resource_has_no_handler(self, tmp_path):
        assert find_handler(tmp_path, exchange(path="/{id}"), "fastapi") == ""

    def test_a_route_declared_in_code_is_found_and_tests_are_not(self, tmp_path):
        write(
            tmp_path,
            "app/routes.py",
            '@router.get("/api/orders")\ndef list_orders(): ...\n',
        )
        write(
            tmp_path,
            "tests/test_routes.py",
            '@router.get("/api/orders")\ndef fake(): ...\n',
        )

        assert find_handler(tmp_path, exchange(), "fastapi") == "app/routes.py"

    def test_a_source_that_cannot_be_read_reads_as_empty(self, tmp_path):
        assert api_tests._read(tmp_path / "gone.py") == ""


class TestWhereItGoes:
    @pytest.fixture
    def project(self, tmp_path) -> Path:
        write(tmp_path, "requirements.txt", "fastapi\npytest\n")
        return tmp_path

    def test_a_stack_that_cannot_be_read_gives_no_draft(self, project, monkeypatch):
        def broken(_root):
            raise OSError("unreadable")

        monkeypatch.setattr(api_tests, "detect_api_stack", broken)

        assert draft_test(project, exchange()) is None

    def test_libraries_that_cannot_be_read_give_a_bare_draft(
        self, project, monkeypatch
    ):
        import test_generation.libraries as libraries
        from project import test_stack

        def broken(*_args):
            raise OSError("unreadable")

        real = test_stack.iter_project_files

        def manifests(root, names):
            if names == ("package.json",):
                raise OSError("unreadable")
            return real(root, names)

        monkeypatch.setattr(libraries, "resolve_selection", broken)
        monkeypatch.setattr(test_stack, "iter_project_files", manifests)

        draft = draft_test(project, exchange())

        assert draft is not None and draft.libraries == []

    def test_a_layout_that_fails_leaves_the_destination_to_choose(
        self, project, monkeypatch
    ):
        import test_generation.layout as layout

        def broken(**_kwargs):
            raise OSError("unreadable")

        monkeypatch.setattr(layout, "resolve_test_destination", broken)

        draft = draft_test(project, exchange())

        assert (draft.path, draft.destination) == ("", "needs_choice")

    @pytest.mark.parametrize("answer", ["", "/elsewhere/test_orders_api.py"])
    def test_a_destination_outside_the_project_or_none_is_no_path(
        self, project, monkeypatch, answer
    ):
        import test_generation.layout as layout

        monkeypatch.setattr(
            layout,
            "resolve_test_destination",
            lambda **_kw: type("D", (), {"path": answer, "status": "resolved"})(),
        )

        draft = draft_test(project, exchange())

        assert (draft.path, draft.destination) == ("", "resolved")


class TestSection:
    def record(self, spec: Path, text: str) -> None:
        target = spec / "docintel" / "result.json"
        target.parent.mkdir(parents=True)
        doc = ExtractedDocument(path="attachments/calls.http", status="text", text=text)
        target.write_text(
            json.dumps(DocintelResult(documents=[doc]).to_dict()), encoding="utf-8"
        )

    def test_without_a_stack_the_call_is_listed_with_no_draft(self, tmp_path):
        spec = tmp_path / ".workpilot" / "specs" / "001"
        self.record(spec, "GET /api/orders\n")

        section = api_tests_section(tmp_path, spec)

        assert "### `GET /api/orders` → not stated" in section
        assert "No HTTP API stack recognised in this project" in section

    def test_a_resolved_destination_is_not_called_a_proposal(
        self, tmp_path, monkeypatch
    ):
        import test_generation.layout as layout

        write(tmp_path, "requirements.txt", "fastapi\npytest\n")
        spec = tmp_path / ".workpilot" / "specs" / "001"
        self.record(spec, f"GET /api/orders\nAuthorization: {PLACEHOLDER}\n")
        target = tmp_path / "tests" / "test_orders_api.py"
        monkeypatch.setattr(
            layout,
            "resolve_test_destination",
            lambda **_kw: type("D", (), {"path": str(target), "status": "resolved"})(),
        )

        section = api_tests_section(tmp_path, spec)

        assert "Destination: `tests/test_orders_api.py`." in section
        assert "this is a proposal" not in section
        assert "A credential header was redacted" in section


class TestContentType:
    def test_a_body_without_its_type_is_sent_as_json(self, tmp_path):
        write(tmp_path, "go.mod", "module example.com/shop\n")
        call = exchange("POST", "/api/orders", '{"qty": 1}', {"X-Tenant": "acme"})

        code = draft_test(tmp_path, call).code

        assert 'req.Header.Set("Content-Type", "application/json")' in code
        assert 'req.Header.Set("X-Tenant", "acme")' in code
