"""Project CRUD + membership management (server mode).

Registration takes a remote ``repo_url``; the server clones it under
``REPOS_ROOT/{project_id}`` and that clone becomes the working tree for
all specs, worktrees and agent runs of the project.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from server.auth.deps import (
    CurrentUser,
    get_current_user,
    get_project_role,
    require_project_role,
)
from server.authz.principal import get_principal
from server.db.engine import get_db
from server.db.models import (
    AuditLog,
    Project,
    ProjectMember,
    ProjectRole,
    User,
)
from server.schemas import (
    AddMemberRequest,
    CreateProjectRequest,
    MemberPublic,
    ProjectPublic,
)
from server.services.events import emit_board_event
from server.services.quotas import enforce_project_quota
from server.services.repos import RepoError, clone_project, delete_clone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectPublic])
async def list_projects(
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProjectPublic]:
    """Projects the caller can see, **within the organization they act in**.

    An organization admin sees every project of their own tenant and none of
    anyone else's. Before multi-tenancy this returned every project on the
    deployment to any admin, which under a shared server would list other
    customers' repositories by name and URL.
    """
    principal = get_principal(request)
    org_id = principal.org_id

    if principal.is_platform_admin and org_id is None:
        # Operating the deployment without having picked a tenant: the listing
        # is genuinely global, and only the platform role reaches here.
        projects = list(await db.scalars(select(Project).order_by(Project.created_at)))
        roles = {p.id: ProjectRole.OWNER.value for p in projects}
    elif principal.has("org.member.write") or user.is_admin:
        # Admin *of this organization*: every project it owns.
        projects = list(
            await db.scalars(
                select(Project)
                .where(Project.org_id == org_id)
                .order_by(Project.created_at)
            )
        )
        roles = {p.id: ProjectRole.OWNER.value for p in projects}
    else:
        result = await db.execute(
            select(Project, ProjectMember.role)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(ProjectMember.user_id == user.id, Project.org_id == org_id)
            .order_by(Project.created_at)
        )
        rows = result.all()
        projects = [p for p, _ in rows]
        roles = {p.id: role for p, role in rows}

    out = []
    for p in projects:
        item = ProjectPublic.model_validate(p)
        item.my_role = roles.get(p.id)
        out.append(item)
    return out


@router.post("", response_model=ProjectPublic, status_code=201)
async def create_project(
    body: CreateProjectRequest,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectPublic:
    principal = get_principal(request)
    org_id = principal.org_id
    if not org_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "No active organization: a project must belong to one. Send the "
                "X-WorkPilot-Org header or call POST /auth/switch-org first."
            ),
        )

    await enforce_project_quota(db, org_id)

    project = Project(
        org_id=org_id,
        name=body.name,
        repo_url=body.repo_url.strip(),
        default_branch=body.default_branch.strip() or "main",
        server_path="",  # set after the clone succeeds
        created_by=user.id,
    )
    db.add(project)
    await db.flush()

    try:
        dest = await clone_project(project.id, project.repo_url, project.default_branch)
    except RepoError as e:
        await db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

    project.server_path = str(dest)
    db.add(
        ProjectMember(
            project_id=project.id, user_id=user.id, role=ProjectRole.OWNER.value
        )
    )
    db.add(
        AuditLog(
            user_id=user.id,
            project_id=project.id,
            action="project.created",
            payload={"name": project.name, "repo_url": project.repo_url},
        )
    )
    await db.commit()
    emit_board_event(
        project.id,
        "project_updated",
        {
            "action": "created",
            "name": project.name,
            "user_id": user.id,
            "user_name": user.display_name,
        },
    )

    item = ProjectPublic.model_validate(project)
    item.my_role = ProjectRole.OWNER.value
    return item


@router.get("/{project_id}", response_model=ProjectPublic)
async def get_project(
    project_id: str,
    request: Request,
    user: CurrentUser = Depends(require_project_role(ProjectRole.VIEWER.value)),
    db: AsyncSession = Depends(get_db),
) -> ProjectPublic:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    principal = get_principal(request)
    if not principal.is_platform_admin and project.org_id != principal.org_id:
        # Reported as missing rather than forbidden: a 403 would confirm the id
        # exists, which is itself a cross-tenant leak.
        raise HTTPException(status_code=404, detail="Project not found")
    item = ProjectPublic.model_validate(project)
    item.my_role = await get_project_role(db, user, project_id)
    return item


@router.delete("/{project_id}")
async def delete_project(
    project_id: str,
    user: CurrentUser = Depends(require_project_role(ProjectRole.OWNER.value)),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    await db.delete(project)
    db.add(
        AuditLog(
            user_id=user.id,
            project_id=project_id,
            action="project.deleted",
            payload={"name": project.name},
        )
    )
    await db.commit()
    delete_clone(project_id)
    emit_board_event(
        project_id,
        "project_updated",
        {"action": "deleted", "user_id": user.id, "user_name": user.display_name},
    )
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


@router.get("/{project_id}/members", response_model=list[MemberPublic])
async def list_members(
    project_id: str,
    user: CurrentUser = Depends(require_project_role(ProjectRole.VIEWER.value)),
    db: AsyncSession = Depends(get_db),
) -> list[MemberPublic]:
    result = await db.execute(
        select(ProjectMember, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id)
        .order_by(User.display_name)
    )
    return [
        MemberPublic(
            user_id=u.id,
            email=u.email,
            display_name=u.display_name,
            avatar_url=u.avatar_url,
            role=m.role,
        )
        for m, u in result.all()
    ]


@router.post("/{project_id}/members", response_model=MemberPublic, status_code=201)
async def add_member(
    project_id: str,
    body: AddMemberRequest,
    user: CurrentUser = Depends(require_project_role(ProjectRole.OWNER.value)),
    db: AsyncSession = Depends(get_db),
) -> MemberPublic:
    if body.role not in {r.value for r in ProjectRole}:
        raise HTTPException(status_code=400, detail=f"Invalid role: {body.role}")
    target = await db.get(User, body.user_id)
    if target is None or not target.is_active:
        raise HTTPException(status_code=404, detail="User not found")
    existing = await db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == body.user_id,
        )
    )
    if existing is not None:
        existing.role = body.role
        member = existing
    else:
        member = ProjectMember(
            project_id=project_id, user_id=body.user_id, role=body.role
        )
        db.add(member)
    db.add(
        AuditLog(
            user_id=user.id,
            project_id=project_id,
            action="project.member.added",
            payload={"member": target.email, "role": body.role},
        )
    )
    await db.commit()
    return MemberPublic(
        user_id=target.id,
        email=target.email,
        display_name=target.display_name,
        avatar_url=target.avatar_url,
        role=member.role,
    )


@router.delete("/{project_id}/members/{member_user_id}")
async def remove_member(
    project_id: str,
    member_user_id: str,
    user: CurrentUser = Depends(require_project_role(ProjectRole.OWNER.value)),
    db: AsyncSession = Depends(get_db),
) -> dict:
    member = await db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == member_user_id,
        )
    )
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    await db.delete(member)
    db.add(
        AuditLog(
            user_id=user.id,
            project_id=project_id,
            action="project.member.removed",
            payload={"member_user_id": member_user_id},
        )
    )
    await db.commit()
    return {"removed": True}
