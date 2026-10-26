"""The real UI Automation helper against real windows (Windows only).

A WinForms window is started the way a verification starts an app: through
`verify.launch`, as the root of its own process tree. A second window with the
same title is started by this test, outside that tree: it must never be
listed, read, pinned or captured. The helper is the real one
(`verify/uia/driver.ps1`, Windows PowerShell), so this is what a build does on
a Windows machine, minus the model.

When `dotnet` is installed, a WPF app built from source goes through the same
steps: WPF exposes its controls to UI Automation differently from WinForms.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from foundation.platform import is_windows  # noqa: E402

pytestmark = pytest.mark.skipif(
    not is_windows(), reason="UI Automation exists only on Windows"
)

from verify.detect import Detection, Target, detect_targets  # noqa: E402
from verify.launch import launch  # noqa: E402
from verify.state import stop_all, work_dir  # noqa: E402
from verify.tools import VerifyToolbox  # noqa: E402
from verify.window import UiaDriver, driver_command  # noqa: E402

FORM = textwrap.dedent(
    """
    Add-Type -AssemblyName System.Windows.Forms
    $form = New-Object System.Windows.Forms.Form
    $form.Text = '{title}'
    $form.Width = 420
    $form.Height = 220
    $box = New-Object System.Windows.Forms.TextBox
    $box.Name = 'QuantityBox'
    $box.AccessibleName = 'Quantity'
    $box.Left = 20; $box.Top = 20; $box.Width = 200
    $button = New-Object System.Windows.Forms.Button
    $button.Name = 'SaveButton'
    $button.Text = 'Save'
    $button.Left = 240; $button.Top = 18
    $label = New-Object System.Windows.Forms.Label
    $label.Name = 'StatusLabel'
    $label.Text = '{status}'
    $label.Left = 20; $label.Top = 70; $label.Width = 360
    $button.Add_Click({{ $label.Text = 'Saved ' + $box.Text }})
    $form.Controls.AddRange(@($box, $button, $label))
    [System.Windows.Forms.Application]::Run($form)
    """
)


def _powershell() -> str:
    command = driver_command()
    assert command is not None
    return command[0]


def _write_form(directory: Path, name: str, title: str, status: str) -> Path:
    script = directory / f"{name}.ps1"
    script.write_text(FORM.format(title=title, status=status), encoding="utf-8")
    return script


@pytest.fixture
def decoy(tmp_path):
    """The same title, in a process the verification did not start."""
    script = _write_form(tmp_path, "decoy", "WorkPilot Orders", "DECOY")
    process = subprocess.Popen(
        [
            _powershell(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
        ]
    )
    time.sleep(3)
    yield process
    subprocess.run(
        ["taskkill", "/F", "/T", "/PID", str(process.pid)],
        capture_output=True,
        check=False,
    )


def _toolbox(project: Path, spec: Path, target: Target, title: str) -> VerifyToolbox:
    spec.mkdir(parents=True, exist_ok=True)
    (spec / "task_metadata.json").write_text(
        json.dumps({"verifyWindow": title}), encoding="utf-8"
    )
    box = VerifyToolbox(project, spec, changed_files=[])
    box._detection = Detection(targets=[target])
    return box


def _ref(box: VerifyToolbox, target: Target, automation_id: str) -> str:
    rows = box.window(target).rows
    found = [r for r in rows.values() if r.get("automationId") == automation_id]
    assert found, f"{automation_id} not in {list(rows.values())}"
    return str(found[0]["ref"])


async def _drive(
    box: VerifyToolbox, target: Target, box_id: str, button_id: str
) -> str:
    snapshot = await box.call("verify_window", {"action": "snapshot"})
    assert "DECOY" not in snapshot, snapshot
    field = _ref(box, target, box_id)
    answer = await box.call(
        "verify_window", {"action": "fill", "ref": field, "value": "3"}
    )
    assert answer.startswith("Done"), answer
    button = _ref(box, target, button_id)
    answer = await box.call("verify_window", {"action": "click", "ref": button})
    assert answer.startswith("Done"), answer
    answer = await box.call("verify_window", {"action": "wait_for", "text": "Saved 3"})
    assert answer == "Found: 'Saved 3'", answer
    shot = json.loads(await box.call("verify_screenshot", {"label": "order saved"}))
    await box.aclose()
    return shot["path"]


def test_a_winforms_window_is_driven_and_captured_alone(tmp_path, decoy):
    project = tmp_path / "project"
    project.mkdir()
    script = _write_form(project, "app", "WorkPilot Orders", "Ready")
    target = Target(
        kind="windows-app",
        name="orders",
        command=f"{_powershell()} -NoProfile -ExecutionPolicy Bypass -File app.ps1",
    )
    spec = tmp_path / "spec"
    box = _toolbox(project, spec, target, "Orders")
    base = work_dir(project, spec)
    try:
        result = launch(target, project, base, timeout=90, window_title="Orders")
        assert result.status == "ready", result.to_dict()
        assert result.window["namedBy"] == "card"
        # The decoy has the same title and was there first: never chosen.
        assert result.window["pid"] != decoy.pid

        driver = UiaDriver()
        try:
            listed = driver.request(
                "windows", {"pid": result.pid, "title": "", "hwnd": 0}
            )
        finally:
            driver.close()
        assert listed and all(w["pid"] != decoy.pid for w in listed)

        path = asyncio.run(_drive(box, target, "QuantityBox", "SaveButton"))
        png = Path(path).read_bytes()
        assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 1000
        assert script.is_file()
    finally:
        stop_all(base)


def test_a_window_the_app_does_not_show_is_never_found_elsewhere(tmp_path, decoy):
    project = tmp_path / "project"
    project.mkdir()
    _write_form(project, "app", "Something else", "Ready")
    target = Target(
        kind="windows-app",
        name="other",
        command=f"{_powershell()} -NoProfile -ExecutionPolicy Bypass -File app.ps1",
    )
    base = work_dir(project, None)
    try:
        # The decoy is titled "WorkPilot Orders"; the launched app is not.
        result = launch(target, project, base, timeout=20, window_title="Orders")
    finally:
        stop_all(base)
    assert result.status == "timeout"
    assert result.detail.startswith("no window titled 'Orders'")


WPF_PROJECT = {
    "Orders.csproj": """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
  </PropertyGroup>
</Project>
""",
    "App.xaml": """<Application x:Class="Orders.App"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    StartupUri="MainWindow.xaml" />
""",
    "App.xaml.cs": "namespace Orders { public partial class App : System.Windows.Application { } }\n",
    "MainWindow.xaml": """<Window x:Class="Orders.MainWindow"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    Title="Orders (WPF)" Width="420" Height="220">
  <StackPanel Margin="12">
    <TextBox x:Name="QuantityBox" AutomationProperties.AutomationId="QuantityBox" />
    <Button x:Name="SaveButton" AutomationProperties.AutomationId="SaveButton" Content="Save" Click="OnSave" />
    <TextBlock x:Name="StatusText" Text="Ready" />
  </StackPanel>
</Window>
""",
    "MainWindow.xaml.cs": """namespace Orders {
  public partial class MainWindow : System.Windows.Window {
    public MainWindow() { InitializeComponent(); }
    void OnSave(object sender, System.Windows.RoutedEventArgs e) { StatusText.Text = "Saved " + QuantityBox.Text; }
  }
}
""",
}


@pytest.mark.skipif(shutil.which("dotnet") is None, reason="dotnet is not installed")
def test_a_wpf_app_is_detected_launched_and_driven(tmp_path):
    project = tmp_path / "project"
    app = project / "Orders"
    app.mkdir(parents=True)
    for name, text in WPF_PROJECT.items():
        (app / name).write_text(text, encoding="utf-8")
    build = subprocess.run(
        ["dotnet", "build", str(app / "Orders.csproj"), "-nologo", "-v", "q"],
        capture_output=True,
        text=True,
        timeout=600,
        env={**os.environ, "DOTNET_CLI_TELEMETRY_OPTOUT": "1"},
    )
    assert build.returncode == 0, build.stdout[-2000:] + build.stderr[-2000:]
    (target,) = detect_targets(project).targets
    assert (target.kind, target.framework) == ("windows-app", "wpf")
    spec = tmp_path / "spec"
    box = _toolbox(project, spec, target, "Orders (WPF)")
    base = work_dir(project, spec)
    try:
        result = launch(target, project, base, timeout=300, window_title="Orders (WPF)")
        assert result.status == "ready", result.to_dict()
        path = asyncio.run(_drive(box, target, "QuantityBox", "SaveButton"))
        assert Path(path).stat().st_size > 1000
    finally:
        stop_all(base)
