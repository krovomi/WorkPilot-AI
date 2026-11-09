"""The contract diff of OpenAPI, GraphQL and protobuf, classified the same way (#389).

Each format is parsed into the same model and compared by the same rules:
what removes or narrows breaks, what widens or deprecates may break, what
adds does not. A change the new contract declares intended
(``x-breaking-acknowledged``) is still reported, marked acknowledged.
"""

from __future__ import annotations

import pytest
from api_watcher import BreakingChangeDetector, ContractFormat, ContractParser


def _changes(
    old: str, new: str, fmt: ContractFormat
) -> dict[str, tuple[str, str, bool]]:
    parser = ContractParser()
    diff = BreakingChangeDetector().diff(
        parser.parse_string(old, fmt), parser.parse_string(new, fmt)
    )
    return {
        c.path: (c.change_type.value, c.category.value, c.acknowledged)
        for c in diff.changes
    }


OPENAPI_OLD = """
openapi: 3.0.0
info: {title: Orders, version: "1"}
paths:
  /orders/{id}:
    parameters:
      - {name: id, in: path, required: true, schema: {type: integer, format: int32}}
    get:
      operationId: getOrder
      parameters:
        - {name: expand, in: query, schema: {type: string}}
      responses:
        "200": {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/Order'}}}}
        "404": {description: nf}
  /orders:
    post:
      requestBody:
        content: {application/json: {schema: {type: object, properties: {item: {type: string}}}}}
      responses: {"201": {description: created}}
  /legacy:
    get: {responses: {"200": {description: ok}}}
components:
  schemas:
    Order:
      type: object
      required: [id]
      properties:
        id: {type: integer, format: int32}
        status: {type: string, enum: [new, paid, shipped]}
        note: {type: string}
"""

OPENAPI_NEW = """
openapi: 3.0.0
info: {title: Orders, version: "2"}
paths:
  /orders/{orderId}:
    parameters:
      - {name: orderId, in: path, required: true, schema: {type: integer, format: int64}}
    get:
      operationId: getOrder
      parameters:
        - {name: expand, in: query, required: true, schema: {type: string}}
      responses:
        "200": {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/Order'}}}}
        "410": {description: gone}
  /orders:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [item, qty]
              properties: {item: {type: string}, qty: {type: integer}}
      responses: {"201": {description: created}}
  /legacy:
    x-breaking-acknowledged: true
components:
  schemas:
    Order:
      type: object
      required: [id]
      properties:
        id: {type: integer, format: int64}
        status: {type: string, enum: [new, paid, delivered]}
        currency: {type: string}
"""


class TestOpenApi:
    @pytest.fixture(scope="class")
    def changes(self):
        return _changes(OPENAPI_OLD, OPENAPI_NEW, ContractFormat.OPENAPI)

    def test_a_renamed_path_parameter_is_the_same_endpoint(self, changes):
        assert "GET /orders/{id}" not in changes
        assert changes["GET /orders/{id}.params.id"][:2] == (
            "parameter_type_changed",
            "potentially_breaking",
        )

    @pytest.mark.parametrize(
        ("path", "kind"),
        [
            ("GET /legacy", "endpoint_removed"),
            ("GET /orders/{id}.params.expand", "parameter_became_required"),
            ("GET /orders/{id}.responses.404", "response_status_removed"),
            ("POST /orders.body", "request_body_changed"),
            ("POST /orders.body.qty", "field_required_added"),
            ("Order.note", "field_removed"),
            ("Order.status.shipped", "enum_value_removed"),
        ],
    )
    def test_what_removes_or_narrows_breaks(self, changes, path, kind):
        assert changes[path][:2] == (kind, "breaking")

    @pytest.mark.parametrize(
        ("path", "kind", "category"),
        [
            ("Order.id", "field_type_changed", "potentially_breaking"),
            ("Order.status.delivered", "enum_value_added", "potentially_breaking"),
            ("Order.currency", "field_added", "non_breaking"),
            ("GET /orders/{id}.responses.410", "response_status_added", "non_breaking"),
        ],
    )
    def test_what_widens_may_break_and_what_adds_does_not(
        self, changes, path, kind, category
    ):
        assert changes[path][:2] == (kind, category)

    def test_an_acknowledged_removal_is_still_reported(self, changes):
        # The path item keeps the annotation after its operations are gone.
        assert changes["GET /legacy"] == ("endpoint_removed", "breaking", True)
        assert changes["Order.note"][2] is False

    def test_the_document_annotation_acknowledges_everything(self):
        new = OPENAPI_NEW.replace(
            'info: {title: Orders, version: "2"}',
            'info: {title: Orders, version: "2", x-breaking-acknowledged: true}',
        )
        changes = _changes(OPENAPI_OLD, new, ContractFormat.OPENAPI)
        assert all(ack for _, _, ack in changes.values())

    def test_an_incompatible_type_change_breaks(self):
        old = "openapi: 3.0.0\ncomponents: {schemas: {A: {properties: {n: {type: integer}}}}}"
        new = "openapi: 3.0.0\ncomponents: {schemas: {A: {properties: {n: {type: string}}}}}"
        assert _changes(old, new, ContractFormat.OPENAPI)["A.n"][1] == "breaking"


GRAPHQL_OLD = '''
"""The API."""
type Query { order(id: ID!): Order  orders(first: Int = 10): [Order!]! }
input NewOrder { item: String! }
enum Status { NEW PAID }
type Order { id: ID! total: Int status: Status }
'''

GRAPHQL_NEW = '''
"""The API."""
type Query {
  # x-breaking-acknowledged
  order(id: ID!, tenant: String!): Order
  orders(first: Int = 10): [Order!]! @deprecated(reason: "use search")
}
input NewOrder { item: String! qty: Int! }
enum Status { NEW REFUNDED }
type Order { id: ID! total: Float status: Status }
'''


class TestGraphQl:
    @pytest.fixture(scope="class")
    def changes(self):
        return _changes(GRAPHQL_OLD, GRAPHQL_NEW, ContractFormat.GRAPHQL)

    def test_a_required_argument_breaks_and_its_ack_is_kept(self, changes):
        assert changes["QUERY order.params.tenant"] == (
            "parameter_added_required",
            "breaking",
            True,
        )

    def test_root_fields_are_compared_once_as_endpoints(self, changes):
        assert not any(path.startswith("Query.") for path in changes)
        assert changes["QUERY orders"][:2] == (
            "endpoint_deprecated",
            "potentially_breaking",
        )

    def test_input_and_enum_rules(self, changes):
        assert changes["NewOrder.qty"][:2] == ("field_required_added", "breaking")
        assert changes["Status.PAID"][:2] == ("enum_value_removed", "breaking")
        assert changes["Status.REFUNDED"][:2] == (
            "enum_value_added",
            "potentially_breaking",
        )
        assert changes["Order.total"][:2] == (
            "field_type_changed",
            "potentially_breaking",
        )


PROTO_OLD = """syntax = "proto3";
package shop;
message Order {
  int32 id = 1;
  string note = 2;
  Item item = 3;
  message Item { string sku = 1; }
  oneof pay { string card = 4; string iban = 5; }
}
enum Status { NEW = 0; PAID = 1; }
service Orders {
  rpc Get (GetReq) returns (Order);
  rpc Del (DelReq) returns (Empty);
}
"""

PROTO_NEW = """syntax = "proto3";
package shop;
message Order {
  int64 id = 1;
  string comment = 2;
  reserved 3;
  message Item { string sku = 2; }
  oneof pay { string card = 4; }
}
enum Status { NEW = 0; }
service Orders {
  rpc Get (GetReq) returns (OrderV2);
  // x-breaking-acknowledged
  rpc Del (DelReq) returns (Empty);
}
"""


class TestProtobuf:
    @pytest.fixture(scope="class")
    def changes(self):
        return _changes(PROTO_OLD, PROTO_NEW, ContractFormat.PROTOBUF)

    def test_numbers_decide_what_is_the_same_field(self, changes):
        assert changes["Order.note"][:2] == ("field_renamed", "potentially_breaking")
        assert changes["Order.Item.sku"][:2] == ("field_number_changed", "breaking")
        assert changes["Order.id"][:2] == ("field_type_changed", "potentially_breaking")

    def test_a_reserved_number_softens_a_removal(self, changes):
        assert changes["Order.item"][:2] == ("field_removed", "potentially_breaking")
        assert changes["Order.iban"][:2] == ("field_removed", "breaking")

    def test_rpc_and_enum_rules(self, changes):
        assert changes["RPC Orders/Get.responses.returns.response"][1] == "breaking"
        assert changes["Status.PAID"][:2] == ("enum_value_removed", "breaking")
        assert "RPC Orders/Del" not in changes

    def test_a_removed_rpc_breaks(self):
        new = PROTO_OLD.replace("  rpc Del (DelReq) returns (Empty);\n", "")
        assert _changes(PROTO_OLD, new, ContractFormat.PROTOBUF)["RPC Orders/Del"][
            :2
        ] == (
            "endpoint_removed",
            "breaking",
        )

    def test_the_file_annotation_covers_every_change(self):
        new = "// x-breaking-acknowledged\n\n" + PROTO_NEW
        changes = _changes(PROTO_OLD, new, ContractFormat.PROTOBUF)
        assert changes and all(ack for _, _, ack in changes.values())
