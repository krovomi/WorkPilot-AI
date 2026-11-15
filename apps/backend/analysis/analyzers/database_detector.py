"""
Database Detector Module
========================

Detects database models and schemas across different ORMs:
- Python: SQLAlchemy, Django ORM
- JavaScript/TypeScript: Prisma, TypeORM, Drizzle, Mongoose
"""

from __future__ import annotations

import re
from pathlib import Path

from .base import BaseAnalyzer


class DatabaseDetector(BaseAnalyzer):
    """Detects database models across multiple ORMs."""

    def __init__(self, path: Path):
        super().__init__(path)

    def detect_all_models(self) -> dict:
        """Detect all database models across different ORMs."""
        models = {}

        # Python SQLAlchemy
        models.update(self._detect_sqlalchemy_models())

        # Python Django
        models.update(self._detect_django_models())

        # Prisma schema
        models.update(self._detect_prisma_models())

        # TypeORM entities
        models.update(self._detect_typeorm_models())

        # Drizzle schema
        models.update(self._detect_drizzle_models())

        # Mongoose models
        models.update(self._detect_mongoose_models())

        return models

    def _detect_sqlalchemy_models(self) -> dict:
        """Detect SQLAlchemy models."""
        models = {}
        py_files = self._project_files("**/*.py")

        for file_path in py_files:
            try:
                content = file_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            # Find class definitions that inherit from Base or db.Model
            class_pattern = (
                r"class\s+(\w+)\([^)]*(?:Base|db\.Model|DeclarativeBase)[^)]*\):"
            )
            matches = list(re.finditer(class_pattern, content))

            for match, body in _class_bodies(content, matches):
                model_name = match.group(1)

                # Extract table name if defined, in this class only: searched
                # in the whole file, every model took the first one's table.
                table_match = re.search(r'__tablename__\s*=\s*["\'](\w+)["\']', body)
                table_name = (
                    table_match.group(1) if table_match else model_name.lower() + "s"
                )

                # Extract columns (the rest of the line: `Column(String(50),
                # unique=True)` holds a ")" before its options).
                fields = {}
                column_pattern = r"^\s*(\w+)\s*=\s*Column\((.*)\)\s*$"
                column_matches = re.finditer(column_pattern, body, re.MULTILINE)

                for col_match in column_matches:
                    field_name = col_match.group(1)
                    field_def = col_match.group(2)

                    # Detect field properties
                    is_primary = "primary_key=True" in field_def
                    is_unique = "unique=True" in field_def
                    is_nullable = "nullable=False" not in field_def

                    # Extract type
                    type_match = re.search(
                        r"(Integer|String|Text|Boolean|DateTime|Float|JSON)", field_def
                    )
                    field_type = type_match.group(1) if type_match else "Unknown"

                    fields[field_name] = {
                        "type": field_type,
                        "primary_key": is_primary,
                        "unique": is_unique,
                        "nullable": is_nullable,
                    }

                if fields:  # Only add if we found fields
                    models[model_name] = {
                        "table": table_name,
                        "fields": fields,
                        "file": file_path.relative_to(self.path).as_posix(),
                        "orm": "SQLAlchemy",
                    }

        return models

    def _detect_django_models(self) -> dict:
        """Detect Django models."""
        models = {}
        model_files = self._project_files("**/models.py") + self._project_files(
            "**/models/*.py"
        )

        for file_path in model_files:
            try:
                content = file_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            # Find class definitions that inherit from models.Model
            class_pattern = r"class\s+(\w+)\(models\.Model\):"
            matches = list(re.finditer(class_pattern, content))

            for match, body in _class_bodies(content, matches):
                model_name = match.group(1)
                table_name = model_name.lower()

                # Extract fields
                fields = {}
                field_pattern = r"^\s*(\w+)\s*=\s*models\.(\w+Field)\((.*)\)\s*$"
                field_matches = re.finditer(field_pattern, body, re.MULTILINE)

                for field_match in field_matches:
                    field_name = field_match.group(1)
                    field_type = field_match.group(2)
                    field_args = field_match.group(3)

                    fields[field_name] = {
                        "type": field_type,
                        "unique": "unique=True" in field_args,
                        "nullable": "null=True" in field_args,
                    }

                if fields:
                    models[model_name] = {
                        "table": table_name,
                        "fields": fields,
                        "file": file_path.relative_to(self.path).as_posix(),
                        "orm": "Django",
                    }

        return models

    def _detect_prisma_models(self) -> dict:
        """Detect Prisma models from schema.prisma."""
        models = {}
        schema_file = self.path / "prisma" / "schema.prisma"

        if not schema_file.exists():
            return models

        try:
            content = schema_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return models

        # Find model definitions
        model_pattern = r"model\s+(\w+)\s*\{([^}]+)\}"
        matches = re.finditer(model_pattern, content, re.MULTILINE)

        for match in matches:
            model_name = match.group(1)
            model_body = match.group(2)

            fields = {}
            # Parse fields: id Int @id @default(autoincrement())
            # The type keeps its "[]" and "?" markers: "\w+" alone left the
            # "?" out, so no field was ever nullable. "@@" lines are model
            # attributes, not fields.
            field_pattern = r"^[ \t]*(\w+)[ \t]+(\w+(?:\[\])?\??)([^/\n]*)"
            field_matches = re.finditer(field_pattern, model_body, re.MULTILINE)

            for field_match in field_matches:
                field_name = field_match.group(1)
                field_type = field_match.group(2)
                field_attrs = field_match.group(3)

                fields[field_name] = {
                    "type": field_type.rstrip("?"),
                    "primary_key": "@id" in field_attrs,
                    "unique": "@unique" in field_attrs,
                    "nullable": field_type.endswith("?"),
                }

            if fields:
                models[model_name] = {
                    "table": model_name.lower(),
                    "fields": fields,
                    "file": "prisma/schema.prisma",
                    "orm": "Prisma",
                }

        return models

    def _detect_typeorm_models(self) -> dict:
        """Detect TypeORM entities."""
        models = {}
        ts_files = self._project_files("**/*.entity.ts") + self._project_files(
            "**/entities/*.ts"
        )

        for file_path in ts_files:
            try:
                content = file_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            # Find @Entity() class declarations
            entity_pattern = r"@Entity\([^)]*\)\s*(?:export\s+)?class\s+(\w+)"
            matches = list(re.finditer(entity_pattern, content))

            for match, body in _class_bodies(content, matches):
                model_name = match.group(1)

                # Extract columns of this entity only
                fields = {}
                column_pattern = (
                    r"@(PrimaryGeneratedColumn|Column)\(([^)]*)\)\s+(\w+):\s*(\w+)"
                )
                column_matches = re.finditer(column_pattern, body)

                for col_match in column_matches:
                    decorator = col_match.group(1)
                    options = col_match.group(2)
                    field_name = col_match.group(3)
                    field_type = col_match.group(4)

                    fields[field_name] = {
                        "type": field_type,
                        "primary_key": decorator == "PrimaryGeneratedColumn",
                        "unique": "unique: true" in options,
                    }

                if fields:
                    models[model_name] = {
                        "table": model_name.lower(),
                        "fields": fields,
                        "file": file_path.relative_to(self.path).as_posix(),
                        "orm": "TypeORM",
                    }

        return models

    def _detect_drizzle_models(self) -> dict:
        """Detect Drizzle ORM schemas."""
        models = {}
        schema_files = self._project_files("**/schema.ts")

        for file_path in schema_files:
            try:
                content = file_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            # Find table definitions: export const users = pgTable('users', {...})
            table_pattern = r'export\s+const\s+(\w+)\s*=\s*(?:pg|mysql|sqlite)Table\(["\'](\w+)["\']'
            matches = re.finditer(table_pattern, content)

            for match in matches:
                const_name = match.group(1)
                table_name = match.group(2)

                models[const_name] = {
                    "table": table_name,
                    "fields": {},  # Would need more parsing for fields
                    "file": file_path.relative_to(self.path).as_posix(),
                    "orm": "Drizzle",
                }

        return models

    def _detect_mongoose_models(self) -> dict:
        """Detect Mongoose models."""
        models = {}
        model_files = self._project_files("**/models/*.js") + self._project_files(
            "**/models/*.ts"
        )

        for file_path in model_files:
            try:
                content = file_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            # Find mongoose.model() or new Schema()
            model_pattern = r'mongoose\.model\(["\'](\w+)["\']'
            matches = re.finditer(model_pattern, content)

            for match in matches:
                model_name = match.group(1)

                models[model_name] = {
                    "table": model_name.lower(),
                    "fields": {},
                    "file": file_path.relative_to(self.path).as_posix(),
                    "orm": "Mongoose",
                }

        return models


def _class_bodies(
    content: str, matches: list[re.Match[str]]
) -> list[tuple[re.Match[str], str]]:
    """Each class declaration with its body, up to the next declaration.

    A fixed window after the declaration ran into the next class of the same
    file, whose columns were then counted twice.
    """
    bodies = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        bodies.append((match, content[match.end() : end]))
    return bodies
