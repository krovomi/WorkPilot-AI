"""
Azure DevOps connector calls made by the desktop app
=====================================================

One call per run, its answer printed as one JSON line: ``{"data": ...}`` or
``{"error": "..."}`` (exit code 1). The app passes every value as an
argument, never as part of a script:

    python connector_call.py <connectors_root> <project_dir> <operation> <params_json>

``connectors_root`` holds the shared ``src/connectors`` package,
``project_dir`` is the project folder whose git remote names the Azure
DevOps project and repository. The credentials come from the environment
(``AZURE_DEVOPS_PAT``, ``AZURE_DEVOPS_ORG_URL``) with the configured project
(``AZURE_DEVOPS_PROJECT``) as a fallback for the remote.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent

OPERATIONS = (
    "test_connection",
    "list_work_items",
    "get_work_item",
    "list_repositories",
    "detect_repository",
)


class CallError(Exception):
    """An answer the app shows as is."""


@dataclass
class FallbackSettings:
    """The connector settings, when the shared package ships without them."""

    pat: str
    organization_url: str
    project: str | None = None
    repository: str | None = None


def _settings_class() -> type:
    try:
        from src.config.settings import Settings
    except ImportError:
        return FallbackSettings
    return Settings


def _work_item(item: Any) -> dict[str, Any]:
    created = item.created_date
    return {
        "id": item.id,
        "title": item.title,
        "description": item.description,
        "state": item.state,
        "workItemType": item.work_item_type,
        "assignedTo": item.assigned_to,
        "tags": item.tags,
        "priority": item.priority,
        "createdDate": created.isoformat()
        if hasattr(created, "isoformat")
        else created,
        "areaPath": item.area_path,
        "iterationPath": item.iteration_path,
        "url": item.url,
        "acceptanceCriteria": item.acceptance_criteria,
    }


def _project(project_dir: Path) -> str | None:
    """The Azure DevOps project of the git remote, else the configured one."""
    from foundation.git_provider import extract_azure_devops_project

    return (
        extract_azure_devops_project(project_dir)
        or os.environ.get("AZURE_DEVOPS_PROJECT")
        or None
    )


def _connector(project: str | None) -> Any:
    pat = os.environ.get("AZURE_DEVOPS_PAT")
    org_url = os.environ.get("AZURE_DEVOPS_ORG_URL")
    if not pat or not org_url:
        raise CallError("Azure DevOps not configured")
    from src.connectors.azure_devops import AzureDevOpsConnector

    connector = AzureDevOpsConnector(
        _settings_class()(pat=pat, organization_url=org_url, project=project)
    )
    connector.connect()
    return connector


def _test_connection(project: str | None) -> Any:
    from msrest.exceptions import ClientException

    connector = _connector(project)
    info = connector.get_connection_info()
    if project:
        try:
            core_client = connector._client._connection.clients.get_core_client()
            core_client.get_project(project)
        except ClientException as error:
            message = str(error)
            if "TF200016" in message or "does not exist" in message.lower():
                raise CallError(
                    f"Project not found: '{project}'. Verify the project name matches "
                    "exactly (case-sensitive) on your Azure DevOps organization."
                ) from error
            raise CallError(f"Cannot access project '{project}': {message}") from error
    return info


def call(project_dir: Path, operation: str, params: dict[str, Any]) -> Any:
    """Runs one operation and gives its data; a `CallError` is the answer."""
    if operation not in OPERATIONS:
        raise CallError(f"Unknown operation: {operation}")
    if operation == "detect_repository":
        from foundation.git_provider import extract_azure_devops_repository

        return {"repository": extract_azure_devops_repository(project_dir)}

    project = _project(project_dir)
    if operation == "test_connection":
        return _test_connection(project)
    if operation == "list_repositories":
        if not project:
            raise CallError("Project name is required to list repositories")
        return [
            {
                "id": repo.id,
                "name": repo.name,
                "project": repo.project,
                "defaultBranch": repo.default_branch,
                "webUrl": repo.web_url,
            }
            for repo in _connector(project).list_repositories(project)
        ]
    connector = _connector(project)
    if operation == "get_work_item":
        item = connector.get_item(project=project, item_id=int(params["work_item_id"]))
        return _work_item(item)
    items = connector.list_backlog_items(
        project, params.get("item_types"), int(params.get("max_items", 100))
    )
    return [_work_item(item) for item in items]


def _answerable_errors() -> tuple[type[BaseException], ...]:
    """What a call can fail with that the app shows as a message (anything else is a traceback)."""
    from msrest.exceptions import ClientException

    from src.connectors.azure_devops.exceptions import AzureDevOpsError

    return (CallError, AzureDevOpsError, ClientException, ValueError, KeyError, OSError)


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            json.dumps(
                {
                    "error": "usage: connector_call.py <connectors_root> <project_dir> <operation> <params_json>"
                }
            )
        )
        return 1
    connectors_root, project_dir, operation, params_json = argv
    # The shared package first, apps/backend last (foundation.git_provider).
    sys.path.insert(0, connectors_root)
    sys.path.append(str(BACKEND_DIR))
    try:
        params = json.loads(params_json)
        if not isinstance(params, dict):
            raise CallError("params must be a JSON object")
        data = call(Path(project_dir), operation, params)
    except _answerable_errors() as error:
        print(json.dumps({"error": str(error)}))
        return 1
    print(json.dumps({"data": data}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
