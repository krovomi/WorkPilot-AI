"""Monthly token budgets per person, group or project.

- ``GET /admin/usage/budgets`` (``usage.read``): the organization's own budget
  (set in Quotas) and each budget it set, with this month's use, and the last
  alerts raised.
- ``PUT /admin/usage/budgets`` (``usage.write``): sets one budget, on a member,
  a group or a project of the organization (404 for any other), audited
  (``usage.budget.set``) with its before and after.
- ``DELETE /admin/usage/budgets/{budget_id}`` (``usage.write``): removes one,
  audited (``usage.budget.removed``).

The audit names a budget's target by its id, never by a name or an address.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from server.auth.deps import CurrentUser
from server.authz.deps import require_org, require_permission
from server.db.engine import get_db
from server.db.models import UsageBudget
from server.services import usage_budgets
from server.services.audit import record
from server.services.usage_budgets import Scope
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["usage"])

SET = "usage.budget.set"
REMOVED = "usage.budget.removed"


class BudgetIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    scope: Scope
    target_id: str = Field(min_length=1, max_length=36)
    monthly_tokens: int = Field(ge=1, le=usage_budgets.MAX_TOKENS)
    block: bool = False


class Budget(BaseModel):
    id: str | None
    scope: str
    target_id: str | None
    name: str | None
    monthly_tokens: int
    block: bool
    used: int
    percent: float


class Alert(BaseModel):
    budget_id: str | None
    scope: str
    month: str
    threshold: int
    percent: float
    recipients: int


class BudgetsOut(BaseModel):
    #: The organization's own monthly budget (Quotas), when set.
    organization: Budget | None
    budgets: list[Budget]
    alerts: list[Alert]


async def _out(db: AsyncSession, org_id: str) -> BudgetsOut:
    found = [Budget(**s.as_dict()) for s in await usage_budgets.statuses(db, org_id)]
    own = next((b for b in found if b.scope == usage_budgets.ORG), None)
    return BudgetsOut(
        organization=own,
        budgets=[b for b in found if b is not own],
        alerts=[Alert(**a) for a in await usage_budgets.last_alerts(db, org_id)],
    )


def _shown(budget: UsageBudget | None) -> dict | None:
    if budget is None:
        return None
    return {"monthly_tokens": budget.monthly_tokens, "block": budget.block}


@router.get(
    "/admin/usage/budgets",
    response_model=BudgetsOut,
    dependencies=[Depends(require_permission("usage.read"))],
)
async def read_budgets(
    org_id: str = Depends(require_org),
    db: AsyncSession = Depends(get_db),
) -> BudgetsOut:
    return await _out(db, org_id)


@router.put("/admin/usage/budgets", response_model=BudgetsOut)
async def set_budget(
    body: BudgetIn,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("usage.write")),
    db: AsyncSession = Depends(get_db),
) -> BudgetsOut:
    name = await usage_budgets.target_name(db, org_id, body.scope, body.target_id)
    if name is None:
        raise HTTPException(status_code=404, detail=f"No such {body.scope}")
    budget = await db.scalar(
        select(UsageBudget).where(
            UsageBudget.org_id == org_id,
            UsageBudget.scope == body.scope,
            UsageBudget.target_id == body.target_id,
        )
    )
    before = _shown(budget)
    if budget is None:
        budget = UsageBudget(org_id=org_id, scope=body.scope, target_id=body.target_id)
        db.add(budget)
    budget.monthly_tokens = body.monthly_tokens
    budget.block = body.block
    await record(
        db,
        action=SET,
        actor_id=actor.id,
        org_id=org_id,
        payload={
            "scope": body.scope,
            "target_id": body.target_id,
            "before": before,
            "after": _shown(budget),
        },
        request=request,
    )
    await db.commit()
    return await _out(db, org_id)


@router.delete("/admin/usage/budgets/{budget_id}", response_model=BudgetsOut)
async def remove_budget(
    budget_id: str,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("usage.write")),
    db: AsyncSession = Depends(get_db),
) -> BudgetsOut:
    budget = await db.get(UsageBudget, budget_id)
    if budget is None or budget.org_id != org_id:
        raise HTTPException(status_code=404, detail="Budget not found")
    await record(
        db,
        action=REMOVED,
        actor_id=actor.id,
        org_id=org_id,
        payload={
            "scope": budget.scope,
            "target_id": budget.target_id,
            "before": _shown(budget),
        },
        request=request,
    )
    await db.delete(budget)
    await db.commit()
    return await _out(db, org_id)
