"""docintel lot C: what a task's diagrams and HTTP captures say, against the code.

Every backend WorkPilot builds, not one: the ORM mapping is read from EF Core,
SQLAlchemy, Django, TypeORM, Prisma, JPA, ActiveRecord, Eloquent and GORM; the
integration test is drafted for ASP.NET Core, FastAPI, Django, Express, Spring
and Go; the module graph comes from `.csproj`, Maven, Gradle, JS workspaces and
Cargo.

The properties that fail silently when they break:

**Structured first.** A Postman collection beats a screenshot of Postman; a
PlantUML PNG's embedded source beats its OCR.

**An ambiguity is said, never scored.** An ERD arrow with no cardinality, a
`1:N` label the code has the other way round, a sequence call nobody could
find by name — each is listed, none becomes a finding.

**A credential never reaches a test file.** `Authorization` in a collection is
replaced before anything is drafted.
"""

from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from docintel import docintel_section, run_preflight  # noqa: E402
from docintel.api_capture import (  # noqa: E402
    PLACEHOLDER,
    parse_exchanges,
    route_of,
)
from docintel.api_tests import (  # noqa: E402
    api_tests_section,
    draft_test,
    exchanges_from_attachments,
)
from docintel.c4 import parse_c4_plantuml, parse_structurizr  # noqa: E402
from docintel.conformance import (  # noqa: E402
    conformance_section,
    read_module_references,
)
from docintel.diagrams import parse_drawio_xml  # noqa: E402
from docintel.erd import (  # noqa: E402
    check_erd,
    erd_from_diagram,
    erd_section,
    parse_dbml,
    parse_mermaid_er,
)
from docintel.orm import read_orm  # noqa: E402
from docintel.sequence import (  # noqa: E402
    check_sequences,
    parse_sequence,
    sequence_section,
)

TOKEN = "eyJ" + "hbGciOiJIUzI1" + ".eyJ" + "zdWIiOiIxMjM0" + "." + "SflKxwRJSMeKKF2QT4"


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def spec_of(root: Path) -> Path:
    spec = root / ".workpilot" / "specs" / "001-task"
    (spec / "attachments").mkdir(parents=True, exist_ok=True)
    return spec


def relations(model) -> set[tuple[str, str, str]]:
    return {(r.kind, r.a, r.b) for r in model.relations}


# ---------------------------------------------------------------------------
# The ORM, in every idiom
# ---------------------------------------------------------------------------


EF_ENTITIES = """namespace Acme.Domain;
public class Customer
{
    public int Id { get; set; }
    public ICollection<Order> Orders { get; set; } = new List<Order>();
}
public class Order
{
    public int Id { get; set; }
    public Customer Customer { get; set; } = null!;
    public List<OrderLine> Lines { get; set; } = new();
}
[Table("order_lines")]
public class OrderLine
{
    public int Id { get; set; }
    public Order Order { get; set; } = null!;
}
public class Invoice
{
    public int Id { get; set; }
    public Order Order { get; set; } = null!;
}
"""

EF_CONTEXT = """public class AppDbContext : DbContext
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderLine> OrderLines { get; set; }
    public DbSet<Invoice> Invoices { get; set; }
}

public class InvoiceConfiguration : IEntityTypeConfiguration<Invoice>
{
    public void Configure(EntityTypeBuilder<Invoice> builder)
    {
        builder.ToTable("invoices");
        builder.HasOne(i => i.Order).WithOne();
    }
}
"""


@pytest.fixture
def efcore(tmp_path: Path) -> Path:
    root = tmp_path / "ef"
    write(root, "src/Acme.Domain/Entities.cs", EF_ENTITIES)
    write(root, "src/Acme.Infrastructure/AppDbContext.cs", EF_CONTEXT)
    return root


class TestOrm:
    def test_efcore_explicit_beats_convention(self, efcore):
        model = read_orm(efcore)
        assert model.frameworks == ["efcore"]
        assert set(model.entities) == {"Customer", "Order", "OrderLine", "Invoice"}
        assert model.entities["OrderLine"].table == "order_lines"
        assert model.entities["Invoice"].table == "invoices"
        assert model.entities["Order"].file == "src/Acme.Domain/Entities.cs"
        assert relations(model) == {
            ("1:N", "Customer", "Order"),
            ("1:N", "Order", "OrderLine"),
            # `HasOne().WithOne()` says one-to-one; the lone navigation would
            # have said many-to-one.
            ("1:1", "Invoice", "Order"),
        }

    def test_sqlalchemy_and_django(self, tmp_path):
        write(
            tmp_path,
            "app/models.py",
            "from sqlalchemy.orm import Mapped, relationship\n"
            "from sqlalchemy import ForeignKey\n\n"
            "class Customer(Base):\n"
            '    __tablename__ = "customers"\n'
            '    orders: Mapped[list["Order"]] = relationship(back_populates="customer")\n\n'
            "class Order(Base):\n"
            '    __tablename__ = "orders"\n'
            '    customer_id = mapped_column(ForeignKey("customers.id"))\n'
            '    customer: Mapped["Customer"] = relationship(back_populates="orders")\n',
        )
        write(
            tmp_path,
            "shop/models.py",
            "from django.db import models\n\n"
            "class Tag(models.Model):\n    name = models.CharField(max_length=20)\n\n"
            "class Product(models.Model):\n"
            "    tags = models.ManyToManyField(Tag)\n"
            '    brand = models.ForeignKey("Brand", on_delete=models.CASCADE)\n\n'
            "class Brand(models.Model):\n"
            "    class Meta:\n        db_table = 'brands'\n",
        )
        model = read_orm(tmp_path)
        assert {"sqlalchemy", "django"} <= set(model.frameworks)
        assert ("1:N", "Customer", "Order") in relations(model)
        assert ("N:N", "Product", "Tag") in relations(model)
        assert ("1:N", "Brand", "Product") in relations(model)
        assert model.entities["Brand"].table == "brands"

    def test_typeorm_prisma_jpa(self, tmp_path):
        write(
            tmp_path,
            "api/src/order.entity.ts",
            '@Entity("orders")\nexport class Order {\n'
            "  @ManyToOne(() => Customer, (c) => c.orders)\n  customer: Customer;\n}\n"
            "@Entity()\nexport class Customer {\n"
            "  @OneToMany(() => Order, (o) => o.customer)\n  orders: Order[];\n}\n",
        )
        write(
            tmp_path,
            "db/schema.prisma",
            'model Author {\n  id Int @id\n  books Book[]\n  @@map("authors")\n}\n'
            "model Book {\n  id Int @id\n  author Author @relation(fields: [authorId], references: [id])\n"
            "  authorId Int\n}\n",
        )
        write(
            tmp_path,
            "svc/src/main/java/com/acme/Invoice.java",
            '@Entity\n@Table(name = "invoices")\npublic class Invoice {\n'
            '    @OneToMany(mappedBy = "invoice")\n    private List<Line> lines;\n}\n'
            "@Entity\npublic class Line {\n    @ManyToOne\n    private Invoice invoice;\n}\n",
        )
        model = read_orm(tmp_path)
        assert {"typeorm", "prisma", "jpa"} <= set(model.frameworks)
        assert ("1:N", "Customer", "Order") in relations(model)
        assert ("1:N", "Author", "Book") in relations(model)
        assert ("1:N", "Invoice", "Line") in relations(model)
        assert model.entities["Order"].table == "orders"
        assert model.entities["Invoice"].table == "invoices"

    def test_activerecord_eloquent_gorm(self, tmp_path):
        write(
            tmp_path,
            "app/models/order.rb",
            "class Order < ApplicationRecord\n  belongs_to :customer\n  has_many :line_items\nend\n",
        )
        write(
            tmp_path,
            "app/models/customer.rb",
            "class Customer < ApplicationRecord\nend\n",
        )
        write(
            tmp_path,
            "app/models/line_item.rb",
            "class LineItem < ApplicationRecord\nend\n",
        )
        write(
            tmp_path,
            "php/app/Models/Post.php",
            "<?php\nclass Post extends Model\n{\n    protected $table = 'posts';\n"
            "    public function user() { return $this->belongsTo(User::class); }\n}\n",
        )
        write(
            tmp_path,
            "php/app/Models/User.php",
            "<?php\nclass User extends Model\n{\n}\n",
        )
        write(
            tmp_path,
            "go/models.go",
            'package models\nimport "gorm.io/gorm"\n'
            "type Team struct {\n\tgorm.Model\n\tMembers []Member\n}\n"
            "type Member struct {\n\tgorm.Model\n\tTeamID uint\n}\n",
        )
        model = read_orm(tmp_path)
        assert {"activerecord", "eloquent", "gorm"} <= set(model.frameworks)
        assert ("1:N", "Customer", "Order") in relations(model)
        assert ("1:N", "Order", "LineItem") in relations(model)
        assert ("1:N", "User", "Post") in relations(model)
        assert ("1:N", "Team", "Member") in relations(model)

    def test_nothing_to_read(self, tmp_path):
        write(tmp_path, "src/app.py", "print('hello')\n")
        assert read_orm(tmp_path).entities == {}


# ---------------------------------------------------------------------------
# The ERD, in every format, and the comparison
# ---------------------------------------------------------------------------

DBML = """Table customers {
  id int [pk]
}
Table orders {
  id int [pk]
  customer_id int [ref: > customers.id]
}
Table order_lines {
  id int
  order_id int
}
Table invoices { id int }
Table payments { id int }
Ref: order_lines.order_id > orders.id
Ref: invoices.id < orders.id
"""

DRAWIO_ERD = """<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="c" value="Customers" style="swimlane" vertex="1" parent="1"/>
<mxCell id="c1" value="id: int" vertex="1" parent="c"/>
<mxCell id="o" value="Orders" style="swimlane" vertex="1" parent="1"/>
<mxCell id="o1" value="customer_id: int" vertex="1" parent="o"/>
<mxCell id="l" value="OrderLines" style="swimlane" vertex="1" parent="1"/>
<mxCell id="e1" style="edgeStyle=entityRelationEdgeStyle;startArrow=ERmandOne;endArrow=ERmany;" edge="1" parent="1" source="c1" target="o1"/>
<mxCell id="e2" value="" edge="1" parent="1" source="o" target="l"/>
</root></mxGraphModel>"""


class TestErd:
    def test_dbml(self):
        erd = parse_dbml(DBML, "model.dbml")
        assert [t.name for t in erd.tables] == [
            "customers",
            "orders",
            "order_lines",
            "invoices",
            "payments",
        ]
        kinds = {(r.kind, r.a, r.b) for r in erd.relations}
        assert ("1:N", "customers", "orders") in kinds
        assert ("1:N", "orders", "order_lines") in kinds
        assert ("1:N", "invoices", "orders") in kinds

    def test_mermaid(self):
        erd = parse_mermaid_er(
            "```mermaid\nerDiagram\n  CUSTOMER ||--o{ ORDER : places\n"
            "  ORDER ||--|{ LINE : contains\n  CUSTOMER {\n    int id PK\n  }\n```",
            "model.md",
        )
        assert {(r.kind, r.a, r.b) for r in erd.relations} == {
            ("1:N", "CUSTOMER", "ORDER"),
            ("1:N", "ORDER", "LINE"),
        }
        assert next(t for t in erd.tables if t.name == "CUSTOMER").columns == ["id"]

    def test_drawio_crows_feet_and_rows(self):
        model = parse_drawio_xml(DRAWIO_ERD)
        assert (
            model.edges[0].source_end == "one" and model.edges[0].target_end == "many"
        )
        erd = erd_from_diagram(model, "docs/data.drawio")
        assert {t.name for t in erd.tables} == {"Customers", "Orders", "OrderLines"}
        rel = {(r.a, r.b): r for r in erd.relations}
        # The arrow joins two *rows*; the relation is between their tables.
        assert rel[("Customers", "Orders")].kind == "1:N"
        assert rel[("OrderLines", "Orders")].ambiguous == "not-drawn"

    def test_an_architecture_diagram_is_not_an_erd(self):
        model = parse_drawio_xml(
            '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
            '<mxCell id="a" value="Api" vertex="1" parent="1"/>'
            '<mxCell id="d" value="Domain" vertex="1" parent="1"/>'
            '<mxCell id="e" edge="1" parent="1" source="a" target="d"/></root></mxGraphModel>'
        )
        assert erd_from_diagram(model, "docs/architecture.drawio") is None

    def test_findings_against_efcore(self, efcore):
        write(efcore, "docs/model.dbml", DBML)
        report = check_erd(efcore)
        kinds = {(f.kind, f.subject) for f in report.findings}
        assert ("missing-entity", "payments") in kinds
        assert ("cardinality-mismatch", "invoices — orders") in kinds
        assert not any(f.kind == "missing-relation" for f in report.findings)
        section = erd_section(efcore)
        assert "drawn `invoices 1:N orders`, mapped `Invoice 1:1 Order`" in section
        assert "`src/Acme.Infrastructure/AppDbContext.cs:" in section

    def test_ambiguity_is_said_not_scored(self, efcore):
        write(efcore, "docs/data.drawio", DRAWIO_ERD)
        report = check_erd(efcore)
        [check] = report.checks
        assert any("cardinality not drawn" in a for a in check.ambiguous)
        assert not any(f.kind == "cardinality-mismatch" for f in report.findings)

    def test_a_label_against_the_code_is_a_direction_question(self, efcore):
        write(
            efcore,
            "docs/erd.drawio",
            '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
            '<mxCell id="o" value="Orders" style="swimlane" vertex="1" parent="1"/>'
            '<mxCell id="o1" value="id" vertex="1" parent="o"/>'
            '<mxCell id="c" value="Customers" style="swimlane" vertex="1" parent="1"/>'
            '<mxCell id="c1" value="id" vertex="1" parent="c"/>'
            '<mxCell id="e" value="1:N" edge="1" parent="1" source="o" target="c"/>'
            "</root></mxGraphModel>",
        )
        report = check_erd(efcore)
        assert report.findings == [] or all(
            f.kind != "cardinality-mismatch" for f in report.findings
        )
        assert any("direction unclear" in a for a in report.checks[0].ambiguous)

    def test_the_tasks_erd_is_the_target(self, efcore):
        spec = spec_of(efcore)
        write(spec, "attachments/target.dbml", DBML)
        run_preflight(spec, efcore, env={})
        section = erd_section(efcore, spec)
        assert "it is the **target** data model" in section
        assert "attachments/target.dbml" in section

    def test_nothing_to_compare(self, efcore, tmp_path):
        assert check_erd(efcore).skipped == "no-erd"
        write(tmp_path / "plain", "docs/model.dbml", DBML)
        assert check_erd(tmp_path / "plain").skipped == "no-orm"
        assert erd_section(efcore) == ""


# ---------------------------------------------------------------------------
# HTTP captures -> integration tests
# ---------------------------------------------------------------------------

POSTMAN = {
    "info": {
        "name": "Acme",
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    "item": [
        {
            "name": "Orders",
            "item": [
                {
                    "name": "Create order",
                    "request": {
                        "method": "POST",
                        "header": [
                            {"key": "Content-Type", "value": "application/json"},
                            {"key": "Authorization", "value": f"Bearer {TOKEN}"},
                            {"key": "X-Tenant", "value": "acme"},
                            {"key": "X-Old", "value": "x", "disabled": True},
                        ],
                        "body": {"mode": "raw", "raw": '{"customerId": 42}'},
                        "url": {
                            "raw": "{{baseUrl}}/api/orders",
                            "path": ["api", "orders"],
                        },
                    },
                    "event": [
                        {
                            "listen": "test",
                            "script": {"exec": ["pm.response.to.have.status(201);"]},
                        }
                    ],
                },
                {
                    "name": "Get order",
                    "request": {"method": "GET", "url": "{{baseUrl}}/api/orders/:id"},
                    "response": [{"code": 200}],
                },
            ],
        }
    ],
}

OPENAPI = {
    "openapi": "3.0.1",
    "paths": {
        "/api/orders": {
            "post": {
                "operationId": "CreateOrder",
                "requestBody": {
                    "content": {"application/json": {"example": {"customerId": 42}}}
                },
                "responses": {"201": {"description": "Created"}, "400": {}},
            }
        }
    },
}


class TestApiCapture:
    def test_postman(self):
        create, get = parse_exchanges(json.dumps(POSTMAN), "c.json")
        assert (create.method, create.path, create.status) == (
            "POST",
            "/api/orders",
            201,
        )
        assert create.headers["Authorization"] == PLACEHOLDER
        assert "X-Old" not in create.headers
        assert create.redacted == ["Authorization"]
        assert (get.path, get.status) == ("/api/orders/{id}", 200)
        assert TOKEN not in json.dumps([e.to_dict() for e in (create, get)])

    def test_openapi_json_and_yaml(self):
        [op] = parse_exchanges(json.dumps(OPENAPI), "swagger.json")
        assert (op.method, op.path, op.status, op.name) == (
            "POST",
            "/api/orders",
            201,
            "CreateOrder",
        )
        assert json.loads(op.body) == {"customerId": 42}
        yaml = pytest.importorskip("yaml")
        [again] = parse_exchanges(yaml.safe_dump(OPENAPI), "openapi.yaml")
        assert again.status == 201

    def test_http_file_and_curl(self):
        http = (
            "@host = https://localhost:5001\n### create\n"
            "POST {{host}}/api/orders HTTP/1.1\nContent-Type: application/json\n\n"
            '{"customerId": 1}\n\n### list\nGET {{host}}/api/orders\n'
        )
        found = parse_exchanges(http, "orders.http")
        assert [(e.method, e.path) for e in found] == [
            ("POST", "/api/orders"),
            ("GET", "/api/orders"),
        ]
        [curl] = parse_exchanges(
            "curl -X PUT https://api.acme.io/api/orders/7 -H 'X-Tenant: acme' \\\n"
            "  -d '{\"qty\": 2}'",
            "ticket.txt",
        )
        assert (curl.method, curl.path, curl.headers) == (
            "PUT",
            "/api/orders/7",
            {"X-Tenant": "acme"},
        )

    def test_ocr_of_a_postman_window(self):
        [shot] = parse_exchanges(
            "My Workspace  Collections\nPOST  https://localhost:5001/api/orders   Send\n"
            "Headers (9)\nContent-Type application/json\nBody\n"
            '{\n  "customerId": 42\n}\nStatus: 201 Created  Time: 120 ms\n',
            "postman.png",
            ocr=True,
        )
        assert (shot.method, shot.path, shot.status, shot.origin) == (
            "POST",
            "/api/orders",
            201,
            "ocr",
        )
        assert json.loads(shot.body) == {"customerId": 42}

    def test_routes(self):
        assert route_of("https://h:5001/api/orders?page=2") == "/api/orders"
        assert route_of("{{baseUrl}}/api/orders/{{id}}") == "/api/orders/{id}"


def aspnet_project(root: Path, *, fluent: bool = True) -> Path:
    write(
        root,
        "src/Acme.Api/Acme.Api.csproj",
        '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
    )
    write(
        root,
        "src/Acme.Api/Controllers/OrdersController.cs",
        '[ApiController]\n[Route("api/[controller]")]\npublic class OrdersController { }\n',
    )
    refs = '<PackageReference Include="xunit" Version="2.9.0" />'
    if fluent:
        refs += '<PackageReference Include="FluentAssertions" Version="6.12.0" />'
    write(
        root,
        "tests/Acme.Api.IntegrationTests/Acme.Api.IntegrationTests.csproj",
        f'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>{refs}</ItemGroup></Project>',
    )
    write(
        root,
        "tests/Acme.Domain.Tests/Acme.Domain.Tests.csproj",
        '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    )
    return root


class TestDrafts:
    def test_aspnetcore_in_the_projects_idiom(self, tmp_path):
        root = aspnet_project(tmp_path / "api")
        [create, _get] = parse_exchanges(json.dumps(POSTMAN), "c.json")
        draft = draft_test(root, create)
        assert draft.stack == "aspnetcore"
        assert "fluentassertions" in draft.libraries
        assert "IClassFixture<WebApplicationFactory<Program>>" in draft.code
        assert "response.StatusCode.Should().Be(HttpStatusCode.Created);" in draft.code
        assert '"X-Tenant", "acme"' in draft.code
        assert "Authorization: redacted" in draft.code and TOKEN not in draft.code
        assert draft.handler == "src/Acme.Api/Controllers/OrdersController.cs"
        # Into the integration-test *project*, not beside it.
        assert draft.path == "tests/Acme.Api.IntegrationTests/OrdersApiTests.cs"

    def test_bare_assert_without_an_assertion_library(self, tmp_path):
        root = aspnet_project(tmp_path / "api", fluent=False)
        [create, _get] = parse_exchanges(json.dumps(POSTMAN), "c.json")
        code = draft_test(root, create).code
        assert "Assert.Equal(HttpStatusCode.Created, response.StatusCode);" in code
        assert "FluentAssertions" not in code

    @pytest.mark.parametrize(
        ("manifest", "content", "stack", "expected"),
        [
            (
                "requirements.txt",
                "fastapi\npytest\n",
                "fastapi",
                "client = TestClient(app)",
            ),
            (
                "requirements.txt",
                "django\npytest-django\n",
                "django",
                "@pytest.mark.django_db",
            ),
            (
                "package.json",
                '{"dependencies": {"express": "4"}, "devDependencies": {"vitest": "1", "supertest": "6"}}',
                "node",
                'import request from "supertest";',
            ),
            (
                "pom.xml",
                "<project><artifactId>spring-boot-starter-web</artifactId></project>",
                "spring",
                "@AutoConfigureMockMvc",
            ),
            ("go.mod", "module example.com/shop\n", "go", "httptest.NewRequest"),
        ],
    )
    def test_every_backend_stack(self, tmp_path, manifest, content, stack, expected):
        write(tmp_path, manifest, content)
        [create, _get] = parse_exchanges(json.dumps(POSTMAN), "c.json")
        draft = draft_test(tmp_path, create)
        assert draft.stack == stack
        assert expected in draft.code
        assert "201" in draft.code and "/api/orders" in draft.code
        assert TOKEN not in draft.code

    def test_no_stack_no_draft(self, tmp_path):
        [create, _get] = parse_exchanges(json.dumps(POSTMAN), "c.json")
        assert draft_test(tmp_path, create) is None

    def test_a_collection_wins_over_the_screenshot(self, tmp_path, monkeypatch):
        from docintel import engines as engines_pkg
        from docintel.engines.base import OcrOutcome

        class Ocr:
            name, local, preview = "tesseract", True, True

            def available(self, env):
                return None

            def recognize(self, image, langs, env):
                return OcrOutcome(
                    text="DELETE https://h/api/customers/1\n204 No Content",
                    engine="tesseract",
                )

        monkeypatch.setattr(engines_pkg, "ENGINES", {"tesseract": Ocr()})
        root = aspnet_project(tmp_path / "api")
        spec = spec_of(root)
        (spec / "attachments" / "postman.png").write_bytes(
            b"\x89PNG\r\n\x1a\n" + b"\0" * 16
        )
        run_preflight(spec, root, env={})
        assert [e.origin for e in exchanges_from_attachments(spec)] == ["ocr"]
        write(spec, "attachments/collection.json", json.dumps(POSTMAN))
        run_preflight(spec, root, env={})
        assert {e.origin for e in exchanges_from_attachments(spec)} == {"postman"}


# ---------------------------------------------------------------------------
# Sequence diagrams
# ---------------------------------------------------------------------------

PUML = """@startuml
actor Client
participant "OrdersController" as C
participant CreateOrderHandler as H
participant IOrderRepository as R
database Db
Client -> C : POST /api/orders
C -> H : Handle(command)
H -> R : AddAsync(order)
R -> Db : INSERT
H --> C : order
C -> Mailer : SendConfirmation(order)
@enduml
"""


def png_with_text(keyword: str, text: str) -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"iTXt", keyword.encode() + b"\0\0\0\0\0" + text.encode("utf-8"))
        + chunk(b"IEND", b"")
    )


@pytest.fixture
def layered(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    write(
        root,
        "src/Api/OrdersController.cs",
        "public class OrdersController { public Task Create() => _handler.Handle(cmd); }\n",
    )
    write(
        root,
        "src/Application/CreateOrderHandler.cs",
        "public class CreateOrderHandler {\n    public Task Handle(CreateOrder c) => _repo.SaveAsync(c);\n}\n",
    )
    write(
        root,
        "src/Application/IOrderRepository.cs",
        "public interface IOrderRepository { Task SaveAsync(Order o); }\n",
    )
    return root


class TestSequences:
    def test_plantuml_calls_verified_or_not(self, layered):
        write(layered, "docs/create-order.puml", PUML)
        [check] = check_sequences(layered).checks
        status = {(c.source, c.target, c.method): c.status for c in check.calls}
        assert (
            status[("OrdersController", "CreateOrderHandler", "Handle")] == "verified"
        )
        assert (
            status[("CreateOrderHandler", "IOrderRepository", "AddAsync")]
            == "method-not-found"
        )
        assert (
            status[("OrdersController", "Mailer", "SendConfirmation")]
            == "type-not-found"
        )
        assert status[("IOrderRepository", "Db", "INSERT")] == "not-code"
        # An HTTP request is not a method call: said, not looked up.
        assert status[("Client", "OrdersController", "")] == "not-a-call"
        # The return arrow is an answer, not a call.
        assert len(check.calls) == 5
        section = sequence_section(layered)
        assert "1 of 3 call(s) verified" in section
        assert "`src/Application/CreateOrderHandler.cs:2`" in section
        assert "not verified" in section and "wrong" not in section.split("\n", 3)[3]

    def test_mermaid_in_markdown(self, layered):
        write(
            layered,
            "docs/flows.md",
            "# Flows\n```mermaid\nsequenceDiagram\n  participant C as OrdersController\n"
            "  C->>CreateOrderHandler: Handle(cmd)\n  CreateOrderHandler-->>C: order\n```\n",
        )
        [check] = check_sequences(layered).checks
        assert check.format == "mermaid"
        assert [c.status for c in check.calls] == ["verified"]

    def test_plantuml_png_carries_its_source(self, layered):
        (layered / "docs").mkdir(exist_ok=True)
        (layered / "docs" / "flow.png").write_bytes(png_with_text("plantuml", PUML))
        [check] = check_sequences(layered).checks
        assert check.diagram == "docs/flow.png" and check.verified == 1

    def test_prose_is_not_a_sequence(self):
        assert parse_sequence("The controller calls the handler.", "notes.md") is None


# ---------------------------------------------------------------------------
# C4 as code, and module graphs beyond .NET
# ---------------------------------------------------------------------------

STRUCTURIZR = """workspace "Shop" {
  model {
    user = person "User"
    shop = softwareSystem "Shop" {
      api = container "Api"
      app = container "Application"
      domain = container "Domain"
      infra = container "Infrastructure" {
        -> app "implements ports"
      }
    }
    user -> shop.api "uses"
    api -> app "calls"
    app -> domain "uses"
  }
  views {
    container shop { include * }
  }
}
"""


class TestC4:
    def test_structurizr(self):
        model = parse_structurizr(STRUCTURIZR, "workspace")
        labels = {n.id: n.label for n in model.nodes}
        assert labels["api"] == "Api" and labels["infra"] == "Infrastructure"
        assert next(n for n in model.nodes if n.id == "api").parent == "shop"
        edges = {(e.source, e.target) for e in model.edges}
        assert {
            ("user", "api"),
            ("api", "app"),
            ("app", "domain"),
            ("infra", "app"),
        } == edges

    def test_c4_plantuml(self):
        model = parse_c4_plantuml(
            "@startuml\n!include <C4/C4_Container>\n"
            'System_Boundary(s, "Shop") {\n  Container(api, "Api", "ASP.NET")\n'
            '  ContainerDb(db, "Database", "SQL")\n}\n'
            'Rel(api, db, "reads")\nRel_Back(db, api, "writes")\nBiRel(api, db)\n@enduml'
        )
        assert next(n for n in model.nodes if n.id == "api").parent == "s"
        edges = [(e.source, e.target) for e in model.edges]
        assert edges.count(("api", "db")) == 3 and ("db", "api") in edges

    def test_a_sequence_puml_is_not_c4(self):
        assert parse_c4_plantuml(PUML) is None

    def test_gradle_modules_against_structurizr(self, tmp_path):
        write(
            tmp_path,
            "settings.gradle.kts",
            'include(":api", ":application", ":domain", ":infrastructure")\n',
        )
        write(
            tmp_path,
            "api/build.gradle.kts",
            'dependencies { implementation(project(":application")) }\n',
        )
        write(
            tmp_path,
            "application/build.gradle.kts",
            'dependencies { implementation(project(":domain")) }\n',
        )
        write(
            tmp_path,
            "domain/build.gradle.kts",
            'dependencies { implementation(project(":infrastructure")) }\n',
        )
        write(
            tmp_path,
            "infrastructure/build.gradle.kts",
            'dependencies { implementation(project(":application")) }\n',
        )
        write(tmp_path, "docs/workspace.dsl", STRUCTURIZR)
        section = conformance_section(tmp_path)
        assert (
            "`domain` (Domain) -> `infrastructure` (Infrastructure) points backwards"
            in section
        )
        assert "`domain/build.gradle.kts`" in section

    def test_maven_workspaces_and_cargo(self, tmp_path):
        write(
            tmp_path,
            "domain/pom.xml",
            "<project><artifactId>shop-domain</artifactId></project>",
        )
        write(
            tmp_path,
            "api/pom.xml",
            "<project><artifactId>shop-api</artifactId><dependencies>"
            "<dependency><artifactId>shop-domain</artifactId></dependency>"
            "<dependency><artifactId>spring-web</artifactId></dependency>"
            "</dependencies></project>",
        )
        write(
            tmp_path, "package.json", '{"private": true, "workspaces": ["packages/*"]}'
        )
        write(tmp_path, "packages/core/package.json", '{"name": "@shop/core"}')
        write(
            tmp_path,
            "packages/web/package.json",
            '{"name": "@shop/web", "dependencies": {"@shop/core": "workspace:*", "react": "19"}}',
        )
        write(tmp_path, "crates/model/Cargo.toml", '[package]\nname = "model"\n')
        write(
            tmp_path,
            "crates/server/Cargo.toml",
            '[package]\nname = "server"\n\n[dependencies]\nmodel = { path = "../model" }\n',
        )
        modules, edges = read_module_references(tmp_path)
        assert {
            "shop-api",
            "shop-domain",
            "@shop/core",
            "@shop/web",
            "model",
            "server",
        } <= set(modules)
        pairs = {(a, b) for a, b, _f in edges}
        assert {
            ("shop-api", "shop-domain"),
            ("@shop/web", "@shop/core"),
            ("server", "model"),
        } <= pairs
        assert not any(b in ("spring-web", "react") for _a, b in pairs)

    def test_an_erd_is_not_an_architecture_diagram(self, efcore):
        write(efcore, "docs/data.drawio", DRAWIO_ERD)
        assert conformance_section(efcore) == ""


# ---------------------------------------------------------------------------
# End to end: attachments, through run_preflight, to the prompt and the card
# ---------------------------------------------------------------------------


class TestEndToEnd:
    def test_a_task_with_an_erd_a_sequence_and_a_collection(self, efcore):
        write(
            efcore,
            "src/Acme.Api/Acme.Api.csproj",
            '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
        )
        write(
            efcore,
            "src/Acme.Api/Controllers/OrdersController.cs",
            '[Route("api/[controller]")]\npublic class OrdersController {\n'
            "    public Task Create() => _handler.Handle(cmd);\n}\n",
        )
        spec = spec_of(efcore)
        write(spec, "attachments/target.dbml", DBML)
        write(
            spec,
            "attachments/flow.puml",
            "@startuml\nOrdersController -> CreateOrderHandler : Handle(cmd)\n@enduml\n",
        )
        write(spec, "attachments/orders.postman_collection.json", json.dumps(POSTMAN))

        result = run_preflight(spec, efcore, env={})
        assert {d.status for d in result.documents} == {"text"}

        section = docintel_section(efcore, spec)
        assert "## Data model: ERD vs. ORM mapping" in section
        assert "## Sequence diagrams vs. code" in section
        assert "## HTTP calls attached to the task → integration tests" in section
        assert "WebApplicationFactory<Program>" in section
        assert TOKEN not in section
        assert TOKEN not in (spec / "docintel" / "result.json").read_text(
            encoding="utf-8"
        )

        from docintel.api import _code_checks

        card = _code_checks(efcore, spec)
        assert card["erd"]["findings"] >= 1
        assert card["sequences"][0]["checkable"] == 1
        assert card["apiTests"][0]["method"] == "POST"
        assert card["apiTests"][0]["destination"].endswith("OrdersApiTests.cs")

    def test_nothing_attached_nothing_said(self, efcore):
        spec = spec_of(efcore)
        assert api_tests_section(efcore, spec) == ""
        from docintel.api import _code_checks

        assert _code_checks(efcore, spec) == {}


class TestMcp:
    def _call(self, root: Path, name: str, arguments: dict) -> dict:
        from docintel.mcp_server import handle

        return handle(
            root.resolve(),
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        )["result"]

    def test_erd_and_api_tools(self, efcore):
        write(efcore, "docs/model.dbml", DBML)
        erd = self._call(efcore, "docintel_erd", {})
        assert "payments" in erd["content"][0]["text"]
        write(
            efcore,
            "src/Acme.Api/Acme.Api.csproj",
            '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
        )
        write(efcore, "api/orders.json", json.dumps(POSTMAN))
        api = self._call(efcore, "docintel_api_test", {"path": "api/orders.json"})
        payload = json.loads(api["content"][0]["text"])
        assert payload["calls"] == 2
        assert "WebApplicationFactory" in payload["drafts"][0]["draft"]["code"]

    def test_api_tool_stays_in_the_project(self, efcore):
        result = self._call(efcore, "docintel_api_test", {"path": "../../etc/passwd"})
        assert result["isError"]
