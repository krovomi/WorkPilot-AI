"""
Design-to-Code stacks
=====================

What "Import Design" knows about each target stack: the instructions the code
generator receives, an example of the files it should return, which generated
files are components, and the visual test that pins a component's rendering.

Web, mobile and desktop stacks all live here, so adding one is one entry in
``STACKS`` (plus its label in the frontend), not a branch in the pipeline. A
stack without a visual-test convention (``test_kind=None``) says so: the
pipeline reports it instead of writing a Playwright test for a XAML window.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath

_A11Y = "Accessible markup (roles, labels, contrast) and a stable test id on the root element"
_RESPONSIVE = "Responsive layout, mobile first"


@dataclass(frozen=True)
class StackProfile:
    """One target stack of the design-to-code pipeline."""

    id: str
    label: str
    group: str  # web | mobile | desktop
    prompt: str
    example_path: str
    example_language: str
    component_languages: tuple[str, ...]
    test_kind: str | None
    supports_web_styles: bool = False


def _prompt(role: str, *rules: str) -> str:
    lines = "\n".join(f"- {rule}" for rule in rules)
    return f"You are an expert {role}. Generate production-ready code using:\n{lines}"


STACKS: dict[str, StackProfile] = {
    s.id: s
    for s in (
        StackProfile(
            "react",
            "React",
            "web",
            _prompt(
                "React developer",
                "Function components in TypeScript",
                "Hooks for state and effects",
                "Typed props interfaces",
                _A11Y,
                _RESPONSIVE,
            ),
            "src/components/PricingCard/PricingCard.tsx",
            "tsx",
            ("tsx", "jsx"),
            "playwright",
            True,
        ),
        StackProfile(
            "nextjs",
            "Next.js",
            "web",
            _prompt(
                "Next.js (App Router) developer",
                "Server components by default, 'use client' only where state or events need it",
                "TypeScript and typed props",
                "next/image and next/link where relevant",
                _A11Y,
                _RESPONSIVE,
            ),
            "app/(marketing)/pricing/PricingCard.tsx",
            "tsx",
            ("tsx", "jsx"),
            "playwright",
            True,
        ),
        StackProfile(
            "vue",
            "Vue",
            "web",
            _prompt(
                "Vue 3 developer",
                'Single-file components with <script setup lang="ts">',
                "Typed defineProps / defineEmits",
                _A11Y,
                _RESPONSIVE,
            ),
            "src/components/PricingCard.vue",
            "vue",
            ("vue",),
            "playwright",
            True,
        ),
        StackProfile(
            "nuxt",
            "Nuxt",
            "web",
            _prompt(
                "Nuxt 3 developer",
                'Auto-imported components under components/ with <script setup lang="ts">',
                "Pages under pages/ only for full screens",
                "NuxtLink and NuxtImg where relevant",
                _A11Y,
                _RESPONSIVE,
            ),
            "components/PricingCard.vue",
            "vue",
            ("vue",),
            "playwright",
            True,
        ),
        StackProfile(
            "angular",
            "Angular",
            "web",
            _prompt(
                "Angular developer",
                "Standalone components with signals and the new control flow (@if, @for)",
                "input() / output() functions with types",
                _A11Y,
                _RESPONSIVE,
            ),
            "src/app/pricing-card/pricing-card.component.ts",
            "ts",
            ("ts",),
            "playwright",
            True,
        ),
        StackProfile(
            "svelte",
            "Svelte",
            "web",
            _prompt(
                "Svelte 5 developer",
                "Runes ($props, $state, $derived) with TypeScript",
                "Scoped styles unless a utility framework is requested",
                _A11Y,
                _RESPONSIVE,
            ),
            "src/lib/components/PricingCard.svelte",
            "svelte",
            ("svelte",),
            "playwright",
            True,
        ),
        StackProfile(
            "blazor",
            "Blazor",
            "web",
            _prompt(
                "Blazor (.NET) developer",
                "Razor components (.razor) with [Parameter] properties and an optional code-behind partial class",
                "CSS isolation (.razor.css) for styles",
                "EventCallback for events",
                _A11Y,
                _RESPONSIVE,
            ),
            "Components/PricingCard.razor",
            "razor",
            ("razor",),
            "playwright",
            True,
        ),
        StackProfile(
            "html",
            "HTML + CSS",
            "web",
            _prompt(
                "front-end developer",
                "Semantic HTML5 and modern CSS (custom properties, grid, flexbox)",
                "No framework; small vanilla JavaScript only for interactions",
                _A11Y,
                _RESPONSIVE,
            ),
            "pricing/pricing-card.html",
            "html",
            ("html",),
            "playwright",
            True,
        ),
        StackProfile(
            "react_native",
            "React Native",
            "mobile",
            _prompt(
                "React Native developer",
                "Function components in TypeScript with StyleSheet.create",
                "Pressable, accessibilityRole and accessibilityLabel",
                "Layout with flexbox that adapts to small and large phones",
                "testID on the root view",
            ),
            "src/components/PricingCard.tsx",
            "tsx",
            ("tsx", "jsx"),
            "rn_snapshot",
        ),
        StackProfile(
            "flutter",
            "Flutter",
            "mobile",
            _prompt(
                "Flutter developer",
                "Stateless widgets unless state is needed, const constructors",
                "Theme.of(context) colours and text styles instead of literals",
                "Semantics labels and a Key on the root widget",
                "LayoutBuilder for adaptive layouts",
            ),
            "lib/widgets/pricing_card.dart",
            "dart",
            ("dart",),
            "flutter_golden",
        ),
        StackProfile(
            "swiftui",
            "SwiftUI",
            "mobile",
            _prompt(
                "SwiftUI developer",
                "Small View structs with #Preview blocks",
                "Colours and fonts from the asset catalogue or a theme type",
                "accessibilityLabel and accessibilityIdentifier",
                "Dynamic Type friendly layouts",
            ),
            "Sources/Views/PricingCard.swift",
            "swift",
            ("swift",),
            "swift_snapshot",
        ),
        StackProfile(
            "jetpack_compose",
            "Jetpack Compose",
            "mobile",
            _prompt(
                "Android Jetpack Compose developer",
                "Stateless @Composable functions with hoisted state and @Preview",
                "MaterialTheme colours and typography instead of literals",
                "Modifier.semantics and testTag on the root",
                "Adaptive layouts for phones and tablets",
            ),
            "app/src/main/java/com/example/ui/PricingCard.kt",
            "kotlin",
            ("kotlin", "kt"),
            "compose_paparazzi",
        ),
        StackProfile(
            "maui",
            ".NET MAUI",
            "mobile",
            _prompt(
                ".NET MAUI developer",
                "XAML ContentView with a code-behind partial class",
                "Bindable properties and MVVM-friendly bindings",
                "Resources from the app's ResourceDictionary (StaticResource)",
                "SemanticProperties and AutomationId",
            ),
            "Views/PricingCard.xaml",
            "xaml",
            ("xaml",),
            None,
        ),
        StackProfile(
            "wpf",
            "WPF / WinUI",
            "desktop",
            _prompt(
                "WPF / WinUI developer",
                "XAML UserControl with a code-behind partial class",
                "Dependency properties and MVVM bindings",
                "Styles and brushes from a ResourceDictionary",
                "AutomationProperties.Name and AutomationId",
            ),
            "Views/PricingCard.xaml",
            "xaml",
            ("xaml",),
            None,
        ),
        StackProfile(
            "avalonia",
            "Avalonia",
            "desktop",
            _prompt(
                "Avalonia UI developer",
                "UserControl (.axaml) with a code-behind partial class",
                "Styled properties and compiled bindings",
                "Styles and resources from the application theme",
                "AutomationProperties.Name",
            ),
            "Views/PricingCard.axaml",
            "xaml",
            ("xaml", "axaml"),
            None,
        ),
    )
}

DEFAULT_STACK = "react"

STYLE_HINTS: dict[str, str] = {
    "tailwind": "Style with Tailwind CSS utility classes; map colours and spacing to the project's theme.",
    "css_modules": "Style with a CSS Module next to each component (Component.module.css).",
    "scss": "Style with SCSS files next to each component, using variables for colours and spacing.",
    "styled_components": "Style with styled-components (typed, co-located with the component).",
}


def get_stack(stack_id: str | None) -> StackProfile:
    """The profile for ``stack_id``; React when the id is unknown or empty."""
    return STACKS.get((stack_id or "").strip().lower(), STACKS[DEFAULT_STACK])


def style_instruction(stack: StackProfile, style: str | None) -> str:
    """The styling instruction for a web stack; empty for native stacks."""
    if not stack.supports_web_styles:
        return ""
    return STYLE_HINTS.get((style or "").strip().lower(), "")


def output_example(stack: StackProfile) -> str:
    """The JSON example of the generator's answer, in the stack's own files."""
    return (
        "[\n"
        "  {\n"
        f'    "path": "{stack.example_path}",\n'
        '    "content": "... full file content ...",\n'
        f'    "language": "{stack.example_language}",\n'
        '    "description": "Main component"\n'
        "  }\n"
        "]"
    )


# --------------------------------------------------------------------------
# Components and their names
# --------------------------------------------------------------------------

_NON_COMPONENT_STEMS = {
    "index",
    "styles",
    "types",
    "main",
    "app",
    "program",
    "mauiprogram",
}


def is_component_file(stack: StackProfile, path: str, language: str) -> bool:
    """Whether a generated file is a component the visual test should cover."""
    lang = (language or "").lower()
    if lang not in stack.component_languages:
        return False
    name = PurePosixPath(path).name.lower()
    if stack.id == "angular":
        return name.endswith(".component.ts")
    if name.endswith((".test.tsx", ".spec.tsx", ".stories.tsx", ".d.ts")):
        return False
    return component_name(path) is not None


def component_name(path: str) -> str | None:
    """``PricingCard`` from ``pricing_card.dart``, ``pricing-card.component.ts``…"""
    p = PurePosixPath(path)
    stem = p.name.split(".", 1)[0]
    if stem.lower() in _NON_COMPONENT_STEMS:
        stem = p.parent.name
    words = [w for w in re.split(r"[^A-Za-z0-9]+", stem) if w]
    if not words:
        return None
    return "".join(w[:1].upper() + w[1:] for w in words)


def _kebab(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()


def _snake(name: str) -> str:
    return _kebab(name).replace("-", "_")


# --------------------------------------------------------------------------
# Visual tests
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class VisualTestDraft:
    name: str
    path: str
    code: str
    description: str


_VIEWPORTS = (("desktop", 1280, 800), ("tablet", 768, 1024), ("mobile", 375, 812))


def _playwright(name: str) -> VisualTestDraft:
    slug = _kebab(name)
    cases = "\n".join(
        f"""  test('{label} {w}x{h}', async ({{ page }}) => {{
    await page.setViewportSize({{ width: {w}, height: {h} }});
    await page.goto('/components/{slug}');
    await page.getByTestId('{slug}').waitFor();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('{slug}')).toHaveScreenshot('{slug}-{label}.png', {{
      maxDiffPixelRatio: 0.02,
    }});
  }});"""
        for label, w, h in _VIEWPORTS
    )
    code = f"""import {{ test, expect }} from '@playwright/test';

// Pins the rendering of {name} on desktop, tablet and mobile viewports.
// Point the route at the page or story that renders the component.
test.describe('{name} visual regression', () => {{
{cases}
}});
"""
    return VisualTestDraft(
        f"{name}VisualTest",
        f"tests/visual/{slug}.spec.ts",
        code,
        f"Playwright screenshots of {name} on 3 viewports",
    )


def _rn_snapshot(name: str) -> VisualTestDraft:
    code = f"""import {{ render }} from '@testing-library/react-native';
import {{ {name} }} from '../src/components/{name}';

// Pins the rendered tree of {name}; update with `jest -u` after an intended change.
describe('{name}', () => {{
  it('matches its snapshot', () => {{
    const tree = render(<{name} />).toJSON();
    expect(tree).toMatchSnapshot();
  }});
}});
"""
    return VisualTestDraft(
        f"{name}SnapshotTest",
        f"__tests__/{name}.snapshot.test.tsx",
        code,
        f"Jest snapshot of {name}",
    )


def _flutter_golden(name: str) -> VisualTestDraft:
    snake = _snake(name)
    sizes = "\n".join(
        f"""  testWidgets('{name} {label}', (tester) async {{
    tester.view.physicalSize = const Size({w}, {h});
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: {name}())));
    await expectLater(find.byType({name}), matchesGoldenFile('goldens/{snake}_{label}.png'));
  }});"""
        for label, w, h in _VIEWPORTS
    )
    code = f"""import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// Golden tests for {name}; refresh with `flutter test --update-goldens`.
void main() {{
{sizes}
}}
"""
    return VisualTestDraft(
        f"{name}GoldenTest",
        f"test/goldens/{snake}_golden_test.dart",
        code,
        f"Flutter golden files of {name} on 3 sizes",
    )


def _swift_snapshot(name: str) -> VisualTestDraft:
    code = f"""import SnapshotTesting
import SwiftUI
import XCTest

// Snapshot tests for {name} (pointfreeco/swift-snapshot-testing).
final class {name}SnapshotTests: XCTestCase {{
    func testIPhone() {{
        assertSnapshot(of: {name}(), as: .image(layout: .device(config: .iPhone13)))
    }}

    func testIPad() {{
        assertSnapshot(of: {name}(), as: .image(layout: .device(config: .iPadPro11)))
    }}
}}
"""
    return VisualTestDraft(
        f"{name}SnapshotTests",
        f"Tests/SnapshotTests/{name}SnapshotTests.swift",
        code,
        f"Snapshot images of {name} on iPhone and iPad",
    )


def _compose_paparazzi(name: str) -> VisualTestDraft:
    code = f"""import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test

// Paparazzi screenshot of {name}; record with `./gradlew recordPaparazziDebug`.
class {name}ScreenshotTest {{
    @get:Rule
    val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5)

    @Test
    fun {name[:1].lower() + name[1:]}() {{
        paparazzi.snapshot {{ {name}() }}
    }}
}}
"""
    return VisualTestDraft(
        f"{name}ScreenshotTest",
        f"app/src/test/java/{name}ScreenshotTest.kt",
        code,
        f"Paparazzi screenshot of {name}",
    )


_BUILDERS = {
    "playwright": _playwright,
    "rn_snapshot": _rn_snapshot,
    "flutter_golden": _flutter_golden,
    "swift_snapshot": _swift_snapshot,
    "compose_paparazzi": _compose_paparazzi,
}


def build_visual_test(stack: StackProfile, name: str) -> VisualTestDraft | None:
    """The visual test of component ``name`` for ``stack``, or ``None``."""
    builder = _BUILDERS.get(stack.test_kind or "")
    return builder(name) if builder else None
