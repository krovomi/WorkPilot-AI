"""Compliance evidence collector: dated audit evidence mapped to framework controls (#357).

`frameworks` reads the controls (SOC 2, ISO/IEC 27001:2022, HIPAA, PCI DSS
4.0, and the project's own YAML), `evidence` the dated evidence the tasks, git
and the configuration left, `report` judges each control and lists the gaps,
`store` saves the reports and runs the monthly one. No model is called.
See docs/architecture/compliance-evidence.md.
"""

from .evidence import Evidence, collect_evidence
from .frameworks import EVIDENCE_KINDS, Control, Framework, load_frameworks
from .report import ALERT_DAYS, build_report, month_period
from .store import (
    list_reports,
    load_config,
    load_report,
    make_report,
    run_monthly,
    save_config,
    save_report,
)

__all__ = [
    "ALERT_DAYS",
    "EVIDENCE_KINDS",
    "Control",
    "Evidence",
    "Framework",
    "build_report",
    "collect_evidence",
    "list_reports",
    "load_config",
    "load_frameworks",
    "load_report",
    "make_report",
    "month_period",
    "run_monthly",
    "save_config",
    "save_report",
]
