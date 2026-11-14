# WorkPilot's UI Automation helper for the verification of Windows apps.
#
# verify/window.py starts it once per session and talks to it one JSON line
# per request on stdin, one JSON line per answer on stdout. It never moves the
# mouse, never types on the keyboard and never captures the screen: it acts
# through UI Automation patterns on elements of ONE window, and captures that
# window alone (PrintWindow). The window must belong to the process tree the
# verification launched; every request carries that scope and it is checked
# again on every request.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
# Alive, before anything slow. PowerShell parses a whole script file before
# its first statement runs; this one is kept short so the line goes out as
# soon as the engine has started. What follows (parsing helper.ps1 and its C#,
# loading UI Automation, compiling or loading the cached assembly) took more
# than a minute on a cold Windows machine: verify/window.py gives it its own
# budget once it reads this line.
[Console]::Out.WriteLine('{"starting":true}')
[Console]::Out.Flush()

. (Join-Path $PSScriptRoot 'helper.ps1')
