#!/usr/bin/env python3
"""
Project analyzer entry point.

Launched by path (`python analyzer.py --output <file>`) by the frontend's
project-context handler, spec discovery, the roadmap and ideation phases.
The implementation is in analysis/analyzer.py; import from there.
"""

from analysis.analyzer import main

if __name__ == "__main__":
    main()
