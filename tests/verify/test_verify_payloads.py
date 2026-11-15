"""`verify.payloads`: the body built from a schema, and a response checked against one.

The schemas are the shapes generated OpenAPI documents really carry: `$ref`
chains, `allOf` composition, nullable types, read-only ids, formats.
"""

from __future__ import annotations

from verify.payloads import instance, resolve, validate

ROOT = {
    "components": {
        "schemas": {
            "Base": {
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "integer", "readOnly": True},
                    "created": {"type": "string", "format": "date-time"},
                },
            },
            "Order": {
                "allOf": [
                    {"$ref": "#/components/schemas/Base"},
                    {
                        "type": "object",
                        "required": ["customer"],
                        "properties": {"customer": {"type": "string"}},
                        "example": {"customer": "Ada"},
                    },
                ],
            },
            "Alias": {"$ref": "#/components/schemas/Order"},
            "Loop": {"$ref": "#/components/schemas/Loop"},
            "a/b": {"type": "boolean"},
            "Nothing": "not a schema",
        }
    }
}


def test_a_ref_is_followed_to_a_schema_and_a_bad_one_is_empty():
    assert resolve({"$ref": "#/components/schemas/a~1b"}, ROOT) == {"type": "boolean"}
    assert (
        resolve({"$ref": "#/components/schemas/Alias"}, ROOT)
        == ROOT["components"]["schemas"]["Order"]
    )
    assert resolve({"$ref": "#/components/schemas/Loop"}, ROOT) == {}
    assert resolve({"$ref": "https://example.com/s.json"}, ROOT) == {}
    assert resolve({"$ref": "#/components/missing/X"}, ROOT) == {}
    assert resolve({"$ref": "#/components/schemas/Nothing"}, ROOT) == {}
    assert resolve("plain text", ROOT) == {}


def test_an_example_given_anywhere_wins():
    assert instance({"type": "integer", "example": 7}) == 7
    assert instance({"type": "string", "default": "x"}) == "x"
    assert instance({"const": "fixed"}) == "fixed"
    assert instance({"type": "string", "examples": ["first", "second"]}) == "first"
    assert instance({"type": "string", "enum": ["open", "closed"]}) == "open"
    # The example a part of `allOf` carries, when the whole has none.
    assert instance({"$ref": "#/components/schemas/Order"}, ROOT) == {"customer": "Ada"}


def test_an_object_sends_its_required_writable_properties():
    schema = {
        "allOf": [
            {"$ref": "#/components/schemas/Base"},
            {
                "required": ["customer", "lines"],
                "properties": {
                    "customer": {"type": "string", "format": "email"},
                    "lines": {
                        "type": "array",
                        "minItems": 2,
                        "items": {"type": "number", "minimum": 0.5},
                    },
                    "note": {"type": "string"},
                },
            },
        ]
    }
    assert instance(schema, ROOT) == {
        "customer": "verify@example.com",
        "lines": [0.5, 0.5],
    }
    # Without `required`, every property is sent.
    assert instance({"properties": {"a": {"type": "boolean"}, "b": {}}}) == {
        "a": True,
        "b": None,
    }


def test_alternatives_take_the_first_that_is_not_null():
    assert instance({"oneOf": [{"type": "null"}, {"type": "integer"}]}) == 1
    assert instance({"anyOf": [{"type": "null"}]}) is None
    assert instance({"type": ["null", "string"]}) == "verify"


def test_values_of_each_type_honour_their_bounds():
    assert instance({"type": "integer", "minimum": 3}) == 3
    assert instance({"type": "integer", "minimum": 3, "exclusiveMinimum": True}) == 4
    assert instance({"type": "integer"}) == 1
    assert instance({"type": "number", "minimum": 2, "exclusiveMinimum": True}) == 3.0
    assert instance({"type": "number"}) == 1.0
    assert instance({"type": "string", "format": "UUID"}).startswith("00000000-")
    assert instance({"type": "string", "minLength": 10}) == "verifyveri"
    assert instance({"type": "string", "maxLength": 3}) == "ver"
    assert instance({"type": "string", "maxLength": 0}) == "v"
    assert instance({"items": {"type": "boolean"}, "minItems": 9}) == [True] * 3
    assert instance({"type": "array", "items": {"type": "file"}}) == []
    assert instance({"type": "file"}) is None


def test_nothing_to_build_is_none():
    assert instance({}) is None
    assert instance(None) is None
    deep: dict = {"type": "integer"}
    for _ in range(10):
        deep = {"type": "object", "required": ["x"], "properties": {"x": deep}}
    built = instance(deep)
    for _ in range(7):
        built = built["x"]
    assert built is None


def test_a_response_that_fits_has_no_problem():
    order = {"$ref": "#/components/schemas/Order"}
    assert validate({"id": 1, "customer": "Ada"}, order, ROOT) == []
    assert (
        validate([{"a": 1}], {"items": {"properties": {"a": {"type": "integer"}}}})
        == []
    )
    assert validate(None, {"type": "string", "nullable": True}) == []
    assert validate(None, {"type": ["string", "null"]}) == []
    assert validate(None, {"description": "anything"}) == []
    assert validate("x", {}) == []
    assert validate(2, {"oneOf": [{"type": "string"}, {"type": "integer"}]}) == []


def test_what_does_not_fit_is_named_by_its_path():
    order = {"$ref": "#/components/schemas/Order"}
    assert validate({"id": "1"}, order, ROOT) == [
        "$.customer: required property missing",
        "$.id: str where integer expected",
    ]
    assert validate(None, {"type": "object"}) == ["$: null where object expected"]
    assert validate(True, {"type": "integer"}) == ["$: bool where integer expected"]
    assert validate(True, {"type": "number"}) == ["$: bool where number expected"]
    assert validate("closed", {"enum": ["open"]}) == [
        "$: 'closed' is not one of ['open']"
    ]
    assert validate(1.5, {"anyOf": [{"type": "string"}, {"type": "boolean"}]}) == [
        "$: matches none of the anyOf alternatives"
    ]
    many = validate(["x"] * 30, {"type": "array", "items": {"type": "integer"}})
    assert len(many) == 20 and many[0] == "$[0]: str where integer expected"
