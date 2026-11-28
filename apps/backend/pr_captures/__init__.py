"""Captures of a task's screens, prepared for its pull request.

Which tasks need them (`decide`), what the team chose (`settings`), personal
data replaced by fakes of the same kind before an image leaves the machine
(`privacy`, `fakes`), and the publishable before/after pairs read from the
shared captures store (`publication`). The verification takes the captures
(`verify/captures_step.py`); the pull request step publishes them.

Design: docs/architecture/pr-captures.md.
"""
