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

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing, System.Web.Extensions

$references = @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.ControlType].Assembly.Location,
    [System.Windows.Threading.Dispatcher].Assembly.Location,
    [System.Drawing.Bitmap].Assembly.Location,
    [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
)

Add-Type -ReferencedAssemblies $references -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class WorkPilotUia
{
    const int MaxRows = 400;
    const int MaxDepth = 30;
    const int MaxSearch = 3000;
    const int MaxText = 200;
    const int ActMilliseconds = 5000;

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    const uint GW_OWNER = 4;
    const uint PW_RENDERFULLCONTENT = 2;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    static Dictionary<string, AutomationElement> refs = new Dictionary<string, AutomationElement>();
    static long refsWindow;

    public static void Init()
    {
        // Physical pixels, so that the rectangle PrintWindow fills is the
        // window's real size on a scaled display.
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
        try { SetProcessDPIAware(); } catch (Exception) { }
    }

    public static string Handle(string line)
    {
        object id = null;
        try
        {
            var request = Json.Deserialize<Dictionary<string, object>>(line);
            if (request == null) throw new ArgumentException("empty request");
            request.TryGetValue("id", out id);
            var result = Dispatch(request);
            return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } });
        }
        catch (Exception exc)
        {
            var inner = exc is AggregateException && exc.InnerException != null ? exc.InnerException : exc;
            return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", inner.GetType().Name + ": " + inner.Message } });
        }
    }

    static object Dispatch(Dictionary<string, object> request)
    {
        string op = Str(request, "op");
        if (op == "ping") return "pong";
        var scope = request.ContainsKey("scope") ? request["scope"] as Dictionary<string, object> : null;
        if (scope == null) throw new ArgumentException("every request names its scope");
        uint pid = (uint)Num(scope, "pid");
        string title = Str(scope, "title");
        long pinned = Num(scope, "hwnd");
        var tree = Tree(pid);
        if (op == "windows") return Describe(TopWindows(tree));
        if (op == "resolve") return Describe(new List<IntPtr> { Resolve(tree, title, pinned) })[0];
        if (pinned == 0) throw new ArgumentException("no window is pinned yet");
        IntPtr window = Resolve(tree, title, pinned);
        if (op == "snapshot") return Snapshot(window, tree);
        if (op == "act") return Act(window, Str(request, "ref"), Str(request, "action"), Str(request, "value"));
        if (op == "find") return Find(window, tree, Str(request, "text"));
        if (op == "capture") return Capture(window, Str(request, "path"));
        throw new ArgumentException("unknown op " + op);
    }

    static string Str(Dictionary<string, object> map, string key)
    {
        object value;
        return map.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
    }

    static long Num(Dictionary<string, object> map, string key)
    {
        object value;
        if (!map.TryGetValue(key, out value) || value == null) return 0;
        return Convert.ToInt64(value);
    }

    // -- the process tree the verification launched ------------------------

    static bool Started(uint pid, Dictionary<uint, DateTime> cache, out DateTime when)
    {
        if (cache.TryGetValue(pid, out when)) return true;
        try
        {
            using (var process = Process.GetProcessById((int)pid)) when = process.StartTime;
            cache[pid] = when;
            return true;
        }
        catch (Exception)
        {
            when = DateTime.MinValue;
            return false;
        }
    }

    static HashSet<uint> Tree(uint root)
    {
        var tree = new HashSet<uint>();
        if (root == 0) return tree;
        var parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(0x2, 0);
        if (snapshot == new IntPtr(-1)) return tree;
        try
        {
            var entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snapshot, ref entry))
            {
                do { parents[entry.th32ProcessID] = entry.th32ParentProcessID; }
                while (Process32NextW(snapshot, ref entry));
            }
        }
        finally { CloseHandle(snapshot); }
        if (!parents.ContainsKey(root)) return tree;
        tree.Add(root);
        var started = new Dictionary<uint, DateTime>();
        bool grew = true;
        while (grew)
        {
            grew = false;
            foreach (var pair in parents)
            {
                if (tree.Contains(pair.Key) || !tree.Contains(pair.Value) || pair.Key == pair.Value) continue;
                // A parent id can be reused: a child counts only when it
                // started after the process that is its parent now.
                DateTime child, parent;
                if (!Started(pair.Key, started, out child) || !Started(pair.Value, started, out parent) || child < parent) continue;
                tree.Add(pair.Key);
                grew = true;
            }
        }
        return tree;
    }

    static List<IntPtr> TopWindows(HashSet<uint> tree)
    {
        var found = new List<IntPtr>();
        if (tree.Count == 0) return found;
        EnumWindows((hWnd, lParam) =>
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (tree.Contains(pid) && IsWindowVisible(hWnd)) found.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static string TitleOf(IntPtr hWnd)
    {
        var text = new StringBuilder(512);
        GetWindowTextW(hWnd, text, text.Capacity);
        return text.ToString();
    }

    static List<Dictionary<string, object>> Describe(List<IntPtr> windows)
    {
        var rows = new List<Dictionary<string, object>>();
        foreach (var hWnd in windows)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            var cls = new StringBuilder(256);
            GetClassNameW(hWnd, cls, cls.Capacity);
            rows.Add(new Dictionary<string, object>
            {
                { "hwnd", hWnd.ToInt64() },
                { "title", TitleOf(hWnd) },
                { "pid", pid },
                { "className", cls.ToString() },
                { "owner", GetWindow(hWnd, GW_OWNER).ToInt64() },
                { "minimized", IsIconic(hWnd) },
            });
        }
        return rows;
    }

    /// The pinned window when it is still a window of the tree; otherwise
    /// the first main window of the tree whose title contains the card's.
    static IntPtr Resolve(HashSet<uint> tree, string title, long pinned)
    {
        if (tree.Count == 0) throw new InvalidOperationException("the launched app is not running");
        var windows = TopWindows(tree);
        if (pinned != 0)
        {
            foreach (var hWnd in windows) if (hWnd.ToInt64() == pinned) return hWnd;
            throw new InvalidOperationException("the target window is closed");
        }
        var seen = new List<string>();
        foreach (var hWnd in windows)
        {
            if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) continue;
            string text = TitleOf(hWnd);
            if (text.Length == 0) continue;
            seen.Add(text);
            if (title.Length == 0 || text.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) return hWnd;
        }
        if (title.Length == 0) throw new InvalidOperationException("the launched app shows no window yet");
        throw new InvalidOperationException("no window of the launched app is titled '" + title + "' (seen: " + string.Join(" | ", seen) + ")");
    }

    /// The pinned window and the dialogs it owns (a message box, a file dialog).
    static List<IntPtr> Roots(IntPtr window, HashSet<uint> tree)
    {
        var roots = new List<IntPtr> { window };
        foreach (var hWnd in TopWindows(tree))
        {
            if (hWnd == window) continue;
            for (IntPtr owner = GetWindow(hWnd, GW_OWNER); owner != IntPtr.Zero; owner = GetWindow(owner, GW_OWNER))
            {
                if (owner == window) { roots.Add(hWnd); break; }
            }
        }
        return roots;
    }

    // -- the elements --------------------------------------------------------

    static string Clip(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        text = text.Replace("\r", " ").Replace("\n", " ");
        return text.Length > MaxText ? text.Substring(0, MaxText) + "..." : text;
    }

    static T Pattern<T>(AutomationElement element, AutomationPattern pattern) where T : class
    {
        object found;
        return element.TryGetCurrentPattern(pattern, out found) ? found as T : null;
    }

    static Dictionary<string, object> Row(AutomationElement element, int depth)
    {
        var current = element.Current;
        var row = new Dictionary<string, object>
        {
            { "depth", depth },
            { "type", current.ControlType.ProgrammaticName.Replace("ControlType.", "") },
            { "name", Clip(current.Name) },
            { "automationId", Clip(current.AutomationId) },
            { "enabled", current.IsEnabled },
            { "offscreen", current.IsOffscreen },
        };
        var actions = new List<string>();
        if (Pattern<InvokePattern>(element, InvokePattern.Pattern) != null) actions.Add("click");
        var value = Pattern<ValuePattern>(element, ValuePattern.Pattern);
        if (value != null)
        {
            row["value"] = current.IsPassword ? "***" : Clip(value.Current.Value);
            if (!value.Current.IsReadOnly) actions.Add("fill");
        }
        var toggle = Pattern<TogglePattern>(element, TogglePattern.Pattern);
        if (toggle != null) { actions.Add("toggle"); row["toggle"] = toggle.Current.ToggleState.ToString(); }
        var item = Pattern<SelectionItemPattern>(element, SelectionItemPattern.Pattern);
        if (item != null) { actions.Add("select"); row["selected"] = item.Current.IsSelected; }
        var expand = Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern);
        if (expand != null) { actions.Add("expand"); row["expanded"] = expand.Current.ExpandCollapseState.ToString(); }
        row["actions"] = actions;
        return row;
    }

    static bool Worth(Dictionary<string, object> row)
    {
        return ((string)row["name"]).Length > 0 || ((string)row["automationId"]).Length > 0
            || row.ContainsKey("value") || ((List<string>)row["actions"]).Count > 0;
    }

    static object Snapshot(IntPtr window, HashSet<uint> tree)
    {
        refs = new Dictionary<string, AutomationElement>();
        refsWindow = window.ToInt64();
        var rows = new List<Dictionary<string, object>>();
        bool truncated = false;
        var walker = TreeWalker.ControlViewWalker;
        foreach (var root in Roots(window, tree))
        {
            var top = AutomationElement.FromHandle(root);
            var stack = new Stack<KeyValuePair<AutomationElement, int>>();
            stack.Push(new KeyValuePair<AutomationElement, int>(top, 0));
            while (stack.Count > 0)
            {
                if (rows.Count >= MaxRows) { truncated = true; break; }
                var pair = stack.Pop();
                Dictionary<string, object> row;
                try { row = Row(pair.Key, pair.Value); }
                catch (ElementNotAvailableException) { continue; }
                if (pair.Value == 0) row["dialog"] = root != window;
                if (pair.Value == 0 || Worth(row))
                {
                    string reference = "e" + (refs.Count + 1);
                    refs[reference] = pair.Key;
                    row["ref"] = reference;
                    rows.Add(row);
                }
                if (pair.Value >= MaxDepth) continue;
                var children = new List<AutomationElement>();
                try
                {
                    for (var child = walker.GetFirstChild(pair.Key); child != null; child = walker.GetNextSibling(child)) children.Add(child);
                }
                catch (ElementNotAvailableException) { }
                for (int i = children.Count - 1; i >= 0; i--)
                    stack.Push(new KeyValuePair<AutomationElement, int>(children[i], pair.Value + 1));
            }
        }
        return new Dictionary<string, object> { { "rows", rows }, { "truncated", truncated } };
    }

    static object Act(IntPtr window, string reference, string action, string value)
    {
        AutomationElement element;
        if (refsWindow != window.ToInt64() || !refs.TryGetValue(reference, out element))
            throw new ArgumentException("unknown ref " + reference + ": take a snapshot first");
        if (!element.Current.IsEnabled) throw new InvalidOperationException(reference + " is disabled");
        Action perform = null;
        string done = action;
        if (action == "click")
        {
            var invoke = Pattern<InvokePattern>(element, InvokePattern.Pattern);
            var toggle = Pattern<TogglePattern>(element, TogglePattern.Pattern);
            var item = Pattern<SelectionItemPattern>(element, SelectionItemPattern.Pattern);
            var expand = Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern);
            if (invoke != null) { perform = invoke.Invoke; done = "invoke"; }
            else if (toggle != null) { perform = toggle.Toggle; done = "toggle"; }
            else if (item != null) { perform = item.Select; done = "select"; }
            else if (expand != null)
            {
                done = "expand";
                perform = () =>
                {
                    if (expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expand.Collapse();
                    else expand.Expand();
                };
            }
        }
        else if (action == "fill")
        {
            var pattern = Pattern<ValuePattern>(element, ValuePattern.Pattern);
            if (pattern == null || pattern.Current.IsReadOnly) throw new InvalidOperationException(reference + " takes no text");
            perform = () => pattern.SetValue(value);
        }
        else if (action == "toggle")
        {
            var pattern = Pattern<TogglePattern>(element, TogglePattern.Pattern);
            if (pattern != null) perform = pattern.Toggle;
        }
        else if (action == "select")
        {
            var pattern = Pattern<SelectionItemPattern>(element, SelectionItemPattern.Pattern);
            if (pattern != null) perform = pattern.Select;
        }
        else if (action == "expand" || action == "collapse")
        {
            var pattern = Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern);
            if (pattern != null)
            {
                if (action == "expand") perform = pattern.Expand;
                else perform = pattern.Collapse;
            }
        }
        else throw new ArgumentException("unknown action " + action);
        if (perform == null)
            throw new InvalidOperationException(reference + " does not support " + action + " (WorkPilot acts through UI Automation only, never with the mouse)");
        // Some frameworks handle a click synchronously: a modal dialog opened
        // by the handler would hold the call until it closes.
        var task = Task.Run(perform);
        bool finished = task.Wait(ActMilliseconds);
        return new Dictionary<string, object> { { "done", done }, { "pending", !finished } };
    }

    static bool Contains(string haystack, string needle)
    {
        return !string.IsNullOrEmpty(haystack) && haystack.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    static object Find(IntPtr window, HashSet<uint> tree, string text)
    {
        if (text.Length == 0) throw new ArgumentException("find needs text");
        var walker = TreeWalker.ControlViewWalker;
        int visited = 0;
        foreach (var root in Roots(window, tree))
        {
            var stack = new Stack<AutomationElement>();
            stack.Push(AutomationElement.FromHandle(root));
            while (stack.Count > 0 && visited < MaxSearch)
            {
                var element = stack.Pop();
                visited++;
                try
                {
                    var current = element.Current;
                    if (Contains(current.Name, text)) return new Dictionary<string, object> { { "found", true } };
                    var value = Pattern<ValuePattern>(element, ValuePattern.Pattern);
                    if (value != null && !current.IsPassword && Contains(value.Current.Value, text))
                        return new Dictionary<string, object> { { "found", true } };
                    for (var child = walker.GetFirstChild(element); child != null; child = walker.GetNextSibling(child)) stack.Push(child);
                }
                catch (ElementNotAvailableException) { }
            }
        }
        return new Dictionary<string, object> { { "found", false }, { "searched", visited } };
    }

    // -- the capture: this window, never the screen ---------------------------

    static object Capture(IntPtr window, string path)
    {
        if (path.Length == 0 || !path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("capture needs a .png path");
        if (IsIconic(window)) throw new InvalidOperationException("the window is minimized");
        RECT rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("the window has no rectangle");
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw new InvalidOperationException("the window has no usable size");
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            bool printed;
            using (var graphics = Graphics.FromImage(bitmap))
            {
                IntPtr hdc = graphics.GetHdc();
                try { printed = PrintWindow(window, hdc, PW_RENDERFULLCONTENT); }
                finally { graphics.ReleaseHdc(hdc); }
            }
            if (!printed) throw new InvalidOperationException("the window could not be printed");
            // One colour everywhere is a window that did not paint, not a capture.
            Color first = bitmap.GetPixel(0, 0);
            bool blank = true;
            for (int x = 0; x < 16 && blank; x++)
                for (int y = 0; y < 16 && blank; y++)
                    if (bitmap.GetPixel(x * (width - 1) / 15, y * (height - 1) / 15) != first) blank = false;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            bitmap.Save(path, ImageFormat.Png);
            return new Dictionary<string, object> { { "path", path }, { "width", width }, { "height", height }, { "blank", blank } };
        }
    }
}
'@

[WorkPilotUia]::Init()
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    [Console]::Out.WriteLine([WorkPilotUia]::Handle($line))
    [Console]::Out.Flush()
}
