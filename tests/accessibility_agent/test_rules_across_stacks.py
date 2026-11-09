"""The WCAG rules read every stack's markup the same way, and stay silent when unsure (#391).

A binding sets the attribute whatever the framework (``:alt``, ``[attr.alt]``,
``alt={…}``, ``alt="@x"``); props spread on an element may set anything; a
component whose output is unknown may render a name. In those cases the rule
says nothing: a false alarm costs the person more than a missed finding.
"""

from __future__ import annotations

import pytest
from accessibility_agent import AccessibilityScanner, WcagLevel
from accessibility_agent.contrast import Tokens
from accessibility_agent.markup import parse


def _rules(
    path: str, content: str, level: str = "AA", tokens: Tokens | None = None
) -> list[str]:
    scanner = AccessibilityScanner(target_level=WcagLevel(level), tokens=tokens)
    return [v.rule_id for v in scanner.scan_file(path, content).violations]


@pytest.mark.parametrize(
    ("path", "markup"),
    [
        ("a.html", '<img src="x.png">'),
        ("A.tsx", "return (<div><img src={x} /></div>);"),
        ("a.vue", '<template><img :src="x"></template>'),
        ("a.component.html", '<img [src]="url">'),
        ("A.svelte", "<img src={x}>"),
        ("Index.razor", '<img src="@Model.Url" />'),
        ("page.blade.php", '<img src="{{ $url }}">'),
        ("a.astro", '<img src="/x.png">'),
        ("a.erb", '<img src="<%= url %>">'),
    ],
)
def test_an_image_without_alt_is_found_in_every_stack(path, markup):
    assert _rules(path, markup) == ["img-alt"]


@pytest.mark.parametrize(
    ("path", "markup"),
    [
        ("A.tsx", "return <img src={x} alt={t('logo')} />;"),
        ("a.vue", '<template><img :alt="label" :src="x"></template>'),
        ("a.vue", '<template><img v-bind:alt="label" :src="x"></template>'),
        ("a.component.html", '<img [attr.alt]="desc" [src]="url">'),
        ("a.component.html", '<img [alt]="desc" [src]="url">'),
        ("Index.razor", '<img src="@Model.Url" alt="@Model.Alt" />'),
        ("a.html", '<img src="spacer.gif" alt="">'),
        ("a.html", '<img src="x.png" role="presentation">'),
        ("A.tsx", "return <img {...props} />;"),
        ("a.vue", '<template><img v-bind="$attrs"></template>'),
    ],
)
def test_a_bound_empty_or_spread_alt_is_not_reported(path, markup):
    assert "img-alt" not in _rules(path, markup)


def test_comparisons_and_generics_in_code_are_not_tags():
    code = """
    const [x, setX] = useState<string>("");
    if (items.length < 3 && x > "a") { return null; }
    const list: Array<Item> = [];
    return <img src="a.png" alt="A cat" />;
    """
    markup = parse("A.tsx", code)
    assert [e.name for e in markup.elements] == ["img"]


def test_markup_inside_comments_is_ignored():
    content = "<!-- <img src='x'> -->\n{/* <img src='y' /> */}\n@* <img src='z'> *@"
    assert _rules("a.html", content) == []


def test_line_numbers_survive_comments_and_multi_line_tags():
    content = "<!--\n\n-->\n<div>\n  <img\n    src='x.png'\n  >\n</div>"
    assert [
        v.line for v in AccessibilityScanner().scan_file("a.html", content).violations
    ] == [5]


class TestLabels:
    def test_a_label_for_the_id_or_a_wrapping_label_names_the_control(self):
        content = '<label for="email">Email</label><input id="email"><label>Age <input type="number"></label>'
        assert _rules("a.html", content) == []

    def test_a_placeholder_is_not_a_label(self):
        violations = (
            AccessibilityScanner()
            .scan_file("a.html", '<input placeholder="Email">')
            .violations
        )
        assert [(v.rule_id, v.detail) for v in violations] == [
            ("control-label", "placeholder only")
        ]

    @pytest.mark.parametrize(
        "markup",
        [
            '<input type="hidden" name="csrf">',
            '<input type="submit" value="Send">',
            '<input aria-label="Search">',
            '<input :aria-label="t(\'q\')" v-model="q">',
            "<input {...field} />",
        ],
    )
    def test_controls_that_need_no_label_or_may_have_one(self, markup):
        assert _rules("A.tsx" if "{..." in markup else "a.vue", markup) == []

    def test_a_blazor_input_without_label_is_found(self):
        assert _rules("Index.razor", '<input @bind="Name" />') == ["control-label"]


class TestNames:
    def test_an_icon_only_button_has_no_name(self):
        code = 'import { Trash2 } from "lucide-react";\nreturn <button onClick={remove}><Trash2 /></button>;'
        assert _rules("A.tsx", code) == ["button-name"]

    @pytest.mark.parametrize(
        "markup",
        [
            "<button>Save</button>",
            "<button>{t('save')}</button>",
            "<button aria-label='Close'><XIcon /></button>",
            "<button><FormattedMessage id='save' /></button>",
            "<button><img src='x.png' alt='Delete'></button>",
        ],
    )
    def test_text_an_expression_a_label_or_a_component_names_it(self, markup):
        assert "button-name" not in _rules("A.tsx", f"return ({markup});")

    def test_an_angular_button_with_only_an_icon_font_has_no_name(self):
        assert _rules(
            "a.component.html",
            '<button (click)="go()"><i class="fa fa-search"></i></button>',
        ) == ["button-name"]

    def test_a_link_without_text(self):
        assert _rules("a.html", '<a href="/cart"><svg></svg></a>') == ["link-name"]


class TestStructure:
    def test_a_skipped_heading_level_is_reported_but_not_the_first_level(self):
        assert _rules(
            "Card.vue", "<template><h3>A</h3><h4>B</h4><h6>C</h6></template>"
        ) == ["heading-order"]

    def test_page_language_title_and_zoom(self):
        page = '<html><head><meta name="viewport" content="width=device-width, user-scalable=no"></head><body></body></html>'
        assert sorted(_rules("index.html", page)) == [
            "meta-viewport",
            "page-lang",
            "page-title",
        ]

    def test_a_layout_with_a_skip_link_passes(self):
        page = '<body><a href="#main">Skip</a><nav><a href="/">Home</a></nav><main id="main"></main></body>'
        assert _rules("layout.html", page) == []
        assert _rules("layout.html", page.replace('<a href="#main">Skip</a>', "")) == [
            "skip-link"
        ]


class TestKeyboardAndAria:
    def test_a_clickable_div_in_each_stack(self):
        for path, markup in [
            ("A.tsx", "return <div onClick={open}>x</div>;"),
            ("a.vue", '<template><div @click="open">x</div></template>'),
            ("a.component.html", '<div (click)="open()">x</div>'),
            ("A.svelte", "<div on:click={open}>x</div>"),
            ("Index.razor", '<div @onclick="Open">x</div>'),
        ]:
            assert _rules(path, markup) == ["click-without-keyboard"], path

    def test_a_clickable_div_with_role_tabindex_and_key_handler_passes(self):
        markup = '<div (click)="x()" role="button" tabindex="0" (keydown.enter)="x()">ok</div>'
        assert _rules("a.component.html", markup) == []

    def test_tabindex_unknown_role_and_hidden_focusable(self):
        content = '<span tabindex="3">a</span><span role="buton">b</span><div aria-hidden="true"><a href="/x">x</a></div>'
        assert sorted(_rules("a.html", content)) == [
            "aria-hidden-focus",
            "aria-role",
            "tabindex-positive",
        ]

    def test_captions_and_frames(self):
        content = (
            '<video src="a.mp4"></video>'
            '<video src="b.mp4" controls><track kind="captions" src="b.vtt"></video>'
            '<video src="bg.mp4" autoplay muted loop></video>'
            '<iframe src="/map"></iframe><iframe src="/m" title="Map"></iframe>'
        )
        assert sorted(_rules("a.html", content)) == ["iframe-title", "video-captions"]


class TestStyles:
    def test_focus_outline_removed_without_replacement(self):
        css = ".btn:focus { outline: none; }\n.link:focus { outline: none; box-shadow: 0 0 0 2px blue; }"
        assert _rules("app.css", css) == ["focus-visible"]
        assert (
            _rules("app.css", css + "\n.btn:focus-visible { outline: 2px solid; }")
            == []
        )

    def test_tailwind_outline_none_needs_a_ring(self):
        assert _rules(
            "A.tsx", 'return <button className="focus:outline-none">x</button>;'
        ) == ["focus-visible"]
        assert (
            _rules(
                "A.tsx",
                'return <button className="focus:outline-none focus-visible:ring-2">x</button>;',
            )
            == []
        )

    def test_target_size_minimum_and_enhanced(self):
        small = 'return <button className="w-4 h-4" aria-label="x"></button>;'
        medium = 'return <button className="w-8 h-8" aria-label="x"></button>;'
        assert _rules("A.tsx", small) == ["target-size"]
        assert _rules("A.tsx", medium) == []
        assert _rules("A.tsx", medium, level="AAA") == ["target-size-enhanced"]
        # Padding grows the target: its size is unknown.
        assert (
            _rules(
                "A.tsx",
                'return <button className="w-4 h-4 p-2" aria-label="x"></button>;',
            )
            == []
        )


def test_level_a_leaves_out_the_aa_rules():
    css = ".muted { color: #aaa; background-color: #fff; }\n.b:focus { outline: 0; }"
    assert sorted(_rules("a.css", css, level="AA")) == [
        "color-contrast",
        "focus-visible",
    ]
    assert _rules("a.css", css, level="A") == []


def test_conditional_and_external_components_carry_a_note():
    code = (
        'import Image from "next/image";\n'
        'import Local from "./Local";\n'
        "return (<div>{show && (\n<img src='/promo.jpg' />\n)}<Image src='/a.png' /></div>);"
    )
    violations = AccessibilityScanner().scan_file("A.tsx", code).violations
    by_line = {v.line: v for v in violations}
    assert by_line[4].conditional and not by_line[4].external
    assert by_line[5].external and not by_line[5].conditional
    vue = '<template><img v-if="ok" src="x.png"></template>'
    assert AccessibilityScanner().scan_file("a.vue", vue).violations[0].conditional


def test_broken_markup_never_raises():
    for junk in ["<", "<div", "<img src='x", "<<<>>>", "<a href=", "</div></div>", "{"]:
        AccessibilityScanner().scan_file("A.tsx", junk)
