"""`test_placement.decide`: where a suite runs, from measures already taken."""

from __future__ import annotations

from test_placement.decide import (
    GIB,
    MIB,
    Decision,
    Demand,
    Gpu,
    Machine,
    Routes,
    decide,
    fits,
)

ROOMY = Machine(
    cores=16, cpu_busy=10.0, ram_total=32 * GIB, ram_free=24 * GIB, builds=2
)
BUSY = Machine(cores=8, cpu_busy=90.0, ram_total=16 * GIB, ram_free=2 * GIB, builds=4)
ALL_ROUTES = Routes(ci=True, has_pr=True, server=True, branch_push=True)


def test_a_roomy_machine_fits_the_default_demand():
    assert fits(ROOMY, Demand()) == ()


def test_a_busy_machine_lacks_cpu_and_ram():
    assert fits(BUSY, Demand()) == ("cpu", "ram")


def test_one_core_is_kept_for_the_person():
    machine = Machine(cores=4, cpu_busy=25.0, ram_total=16 * GIB, ram_free=12 * GIB)
    assert fits(machine, Demand(cores=2.0)) == ()
    assert fits(machine, Demand(cores=2.5)) == ("cpu",)


def test_vram_is_judged_only_when_the_suite_used_some_and_a_gpu_is_read():
    gpu = Gpu(name="RTX", vram_total=8 * GIB, vram_used=7 * GIB)
    with_gpu = Machine(16, 10.0, 32 * GIB, 24 * GIB, gpus=(gpu,))
    assert fits(with_gpu, Demand(vram=2 * GIB)) == ("vram",)
    assert fits(with_gpu, Demand(vram=0)) == ()
    assert fits(Machine(16, 10.0, 32 * GIB, 24 * GIB), Demand(vram=2 * GIB)) == ()
    assert fits(with_gpu, Demand(vram=512 * MIB)) == ()


def test_a_manual_choice_is_obeyed_whatever_the_machine():
    assert decide("machine", BUSY, Demand(), ALL_ROUTES).target == "machine"
    chosen = decide("ci", ROOMY, Demand(), ALL_ROUTES)
    assert (chosen.target, chosen.reason) == ("ci", "chosen")


def test_the_ci_chosen_without_an_app_to_follow_it_stays_here():
    decision = decide("ci", ROOMY, Demand(), Routes())
    assert (decision.target, decision.reason) == ("machine", "not_followed")


def test_alone_the_suite_runs_here_even_on_a_busy_machine():
    alone = Machine(8, 95.0, 16 * GIB, 1 * GIB, builds=0)
    decision = decide("auto", alone, Demand(), ALL_ROUTES)
    assert (decision.target, decision.reason) == ("machine", "alone")


def test_with_room_the_suite_runs_here():
    assert decide("auto", ROOMY, Demand(), ALL_ROUTES).reason == "room"


def test_the_fallback_chain_on_a_busy_machine():
    def target(routes: Routes) -> tuple[str, str]:
        decision = decide("auto", BUSY, Demand(), routes)
        return decision.target, decision.reason

    assert target(ALL_ROUTES) == ("ci", "pr")
    assert target(Routes(ci=True, server=True, branch_push=True)) == (
        "server",
        "server",
    )
    assert target(Routes(ci=True, branch_push=True)) == ("ci", "branch_push")
    assert target(Routes(ci=True)) == ("queue", "no_route")


def test_a_pr_or_a_branch_push_needs_the_app_to_follow_the_ci():
    decision = decide("auto", BUSY, Demand(), Routes(has_pr=True, branch_push=True))
    assert decision.target == "queue"


def test_the_decision_says_what_fell_short_and_the_measures():
    decision = decide("auto", BUSY, Demand(runs=3), Routes(ci=True, branch_push=True))
    data = decision.to_dict()
    assert data["short"] == ["cpu", "ram"]
    assert data["facts"]["cores"] == 8
    assert data["facts"]["builds"] == 4
    assert data["facts"]["measuredRuns"] == 3
    assert "vramFreeMb" not in data["facts"]
    assert isinstance(decision, Decision) and not decision.runs_here
