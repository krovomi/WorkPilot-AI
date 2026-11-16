"""Production incidents grouped by cause (#372): fingerprints, dedup, suspects.

Algorithmic, no model: a fingerprint per error (``fingerprint``), one incident
per fingerprint across every monitoring source with its severity inherited
from the group and from the root cause cluster (``grouping``), and the recent
commits that touched the trace's files ranked from git (``suspects``).

``grouping`` reads the incident models, whose package imports this one: the
incident responder imports ``grouping`` as a module (``from ..production
import grouping``), never its names, so either side may be imported first.
"""
