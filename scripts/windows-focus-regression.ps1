param(
    [ValidateSet('Observe', 'Broken', 'Fixed')]
    [string]$Expectation = 'Observe',
    [ValidateRange(1, 100)]
    [int]$Iterations = 20,
    [ValidateRange(50, 2000)]
    [int]$SettleMilliseconds = 250,
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputDirectory = Join-Path $env:TEMP "nextdesk-focus-regression-$stamp"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

Add-Type -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public sealed class NextDeskFocusWindowInfo
{
    public long Handle { get; set; }
    public uint ProcessId { get; set; }
    public string ClassName { get; set; }
    public string Title { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Right { get; set; }
    public int Bottom { get; set; }
    public bool Visible { get; set; }
    public int Width { get { return Right - Left; } }
    public int Height { get { return Bottom - Top; } }
}

public static class NextDeskFocusNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder value, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder value, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    private static NextDeskFocusWindowInfo Describe(IntPtr handle)
    {
        if (handle == IntPtr.Zero)
        {
            return new NextDeskFocusWindowInfo {
                Handle = 0,
                ClassName = "",
                Title = ""
            };
        }

        uint processId;
        RECT rect;
        var className = new StringBuilder(512);
        var title = new StringBuilder(1024);
        GetWindowThreadProcessId(handle, out processId);
        GetClassName(handle, className, className.Capacity);
        GetWindowText(handle, title, title.Capacity);
        GetWindowRect(handle, out rect);
        return new NextDeskFocusWindowInfo {
            Handle = handle.ToInt64(),
            ProcessId = processId,
            ClassName = className.ToString(),
            Title = title.ToString(),
            Left = rect.Left,
            Top = rect.Top,
            Right = rect.Right,
            Bottom = rect.Bottom,
            Visible = IsWindowVisible(handle)
        };
    }

    public static NextDeskFocusWindowInfo DescribeWindow(IntPtr handle)
    {
        return Describe(handle);
    }

    public static List<NextDeskFocusWindowInfo> EnumerateTopLevelWindows()
    {
        var result = new List<NextDeskFocusWindowInfo>();
        EnumWindows((handle, _) => {
            result.Add(Describe(handle));
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static NextDeskFocusWindowInfo WindowAt(int x, int y)
    {
        return Describe(WindowFromPoint(new POINT { X = x, Y = y }));
    }

    public static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
}

internal sealed class NextDeskSyntheticForegroundForm : Form
{
    private readonly int _holeSize;

    internal NextDeskSyntheticForegroundForm(int left, int top, int width, int height, int holeSize)
    {
        _holeSize = holeSize;
        Text = "NextDesk focus regression foreground";
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(left, top, width, height);
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Color.FromArgb(242, 244, 247);
        ShowInTaskbar = true;
        TopMost = false;
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        var outer = new Region(new Rectangle(0, 0, ClientSize.Width, ClientSize.Height));
        var holeLeft = Math.Max(0, (ClientSize.Width - _holeSize) / 2);
        var holeTop = Math.Max(0, (ClientSize.Height - _holeSize) / 2);
        outer.Exclude(new Rectangle(holeLeft, holeTop, _holeSize, _holeSize));
        Region = outer;
        Activate();
        BringToFront();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using (var brush = new SolidBrush(Color.FromArgb(55, 65, 81)))
        using (var font = new Font("Segoe UI", 12, FontStyle.Regular))
        {
            e.Graphics.DrawString("Foreground focus regression window", font, brush, 24, 20);
        }
    }
}

public static class NextDeskSyntheticForeground
{
    private static Thread _thread;
    private static NextDeskSyntheticForegroundForm _form;
    private static ManualResetEventSlim _ready;

    public static IntPtr Start(int left, int top, int width, int height, int holeSize)
    {
        Stop();
        _ready = new ManualResetEventSlim(false);
        _thread = new Thread(() => {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            _form = new NextDeskSyntheticForegroundForm(left, top, width, height, holeSize);
            _form.Shown += (_, __) => _ready.Set();
            Application.Run(_form);
        });
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.IsBackground = true;
        _thread.Start();
        if (!_ready.Wait(TimeSpan.FromSeconds(8)))
        {
            throw new TimeoutException("Synthetic foreground window did not become ready");
        }
        return _form.Handle;
    }

    public static void Activate()
    {
        var form = _form;
        if (form == null || form.IsDisposed)
        {
            throw new InvalidOperationException("Synthetic foreground window is not running");
        }
        form.Invoke(new Action(() => {
            form.Show();
            form.WindowState = FormWindowState.Normal;
            form.Activate();
            form.BringToFront();
        }));
        NextDeskFocusNative.SetForegroundWindow(form.Handle);
    }

    public static void Stop()
    {
        var form = _form;
        if (form != null && !form.IsDisposed)
        {
            try
            {
                form.Invoke(new Action(() => form.Close()));
            }
            catch
            {
            }
        }
        if (_thread != null && _thread.IsAlive)
        {
            _thread.Join(TimeSpan.FromSeconds(3));
        }
        _form = null;
        _thread = null;
    }
}
'@

function Get-WindowSnapshot {
    param([long]$Handle)

    $info = [NextDeskFocusNative]::DescribeWindow([IntPtr]$Handle)
    $processName = ''
    if ($info.ProcessId -ne 0) {
        try {
            $processName = (Get-Process -Id $info.ProcessId -ErrorAction Stop).ProcessName
        } catch {
            $processName = '<exited>'
        }
    }
    [pscustomobject]@{
        Handle = [long]$info.Handle
        ProcessId = [int]$info.ProcessId
        ProcessName = $processName
        ClassName = [string]$info.ClassName
        Title = [string]$info.Title
        Left = [int]$info.Left
        Top = [int]$info.Top
        Right = [int]$info.Right
        Bottom = [int]$info.Bottom
        Width = [int]$info.Width
        Height = [int]$info.Height
        Visible = [bool]$info.Visible
    }
}

function Get-ForegroundSnapshot {
    Get-WindowSnapshot -Handle ([NextDeskFocusNative]::GetForegroundWindow().ToInt64())
}

function Get-PointWindowSnapshot {
    param([int]$X, [int]$Y)

    $info = [NextDeskFocusNative]::WindowAt($X, $Y)
    Get-WindowSnapshot -Handle $info.Handle
}

function Test-IsNextDeskWindow {
    param($Snapshot, [hashtable]$ProcessIds)

    $Snapshot.ProcessId -ne 0 -and $ProcessIds.ContainsKey([int]$Snapshot.ProcessId)
}

function Test-PointInside {
    param([int]$X, [int]$Y, $Rect)

    $X -ge $Rect.Left -and $X -lt $Rect.Right -and $Y -ge $Rect.Top -and $Y -lt $Rect.Bottom
}

function Set-SyntheticForeground {
    param([IntPtr]$Handle)

    for ($attempt = 1; $attempt -le 10; $attempt++) {
        [NextDeskSyntheticForeground]::Activate()
        Start-Sleep -Milliseconds 80
        if ([NextDeskFocusNative]::GetForegroundWindow() -eq $Handle) {
            return
        }
    }
    $foreground = Get-ForegroundSnapshot
    throw "Unable to activate the synthetic foreground window: $($foreground | ConvertTo-Json -Compress)"
}

function Add-FlatWindowFields {
    param([System.Collections.Specialized.OrderedDictionary]$Row, [string]$Prefix, $Snapshot)

    $Row["${Prefix}Handle"] = $Snapshot.Handle
    $Row["${Prefix}Pid"] = $Snapshot.ProcessId
    $Row["${Prefix}Process"] = $Snapshot.ProcessName
    $Row["${Prefix}Class"] = $Snapshot.ClassName
    $Row["${Prefix}Title"] = $Snapshot.Title
}

$exitCode = 0
$syntheticHandle = [IntPtr]::Zero

try {
    $nextDeskProcesses = @(
        Get-Process -ErrorAction Stop |
            Where-Object { $_.ProcessName -match '^nextdesk' }
    )
    if ($nextDeskProcesses.Count -eq 0) {
        throw 'No running NextDesk process was found'
    }

    $nextDeskPidSet = @{}
    foreach ($process in $nextDeskProcesses) {
        $nextDeskPidSet[[int]$process.Id] = $true
    }

    $overlay = @(
        [NextDeskFocusNative]::EnumerateTopLevelWindows() |
            Where-Object {
                $_.Visible -and
                $_.ClassName -eq 'AtlAxWin' -and
                $nextDeskPidSet.ContainsKey([int]$_.ProcessId) -and
                $_.Width -gt 100 -and
                $_.Height -gt 100
            } |
            Sort-Object -Property @{ Expression = { [long]$_.Width * [long]$_.Height }; Descending = $true }
    ) | Select-Object -First 1

    if ($null -eq $overlay) {
        throw 'No visible NextDesk AtlAxWin RDP overlay was found; connect an RDP session first'
    }

    $overlayProcess = Get-Process -Id $overlay.ProcessId -ErrorAction Stop
    $overlayProcess.Refresh()
    $binaryPath = $overlayProcess.Path
    $binaryVersion = if ($binaryPath) { (Get-Item -LiteralPath $binaryPath).VersionInfo.FileVersion } else { '' }
    $binarySha256 = if ($binaryPath) { (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash } else { '' }

    $windowWidth = [Math]::Max(320, [Math]::Min(900, $overlay.Width - 120))
    $windowHeight = [Math]::Max(240, [Math]::Min(600, $overlay.Height - 120))
    if ($windowWidth -ge $overlay.Width -or $windowHeight -ge $overlay.Height) {
        throw "RDP overlay is too small for a covered and exposed focus test: $($overlay.Width)x$($overlay.Height)"
    }

    $windowLeft = [int]($overlay.Left + (($overlay.Width - $windowWidth) / 2))
    $windowTop = [int]($overlay.Top + (($overlay.Height - $windowHeight) / 2))
    $holeSize = 24
    $coveredX = [int]($windowLeft + ($windowWidth / 2))
    $coveredY = [int]($windowTop + ($windowHeight / 2))

    $syntheticHandle = [NextDeskSyntheticForeground]::Start(
        $windowLeft,
        $windowTop,
        $windowWidth,
        $windowHeight,
        $holeSize
    )
    Start-Sleep -Milliseconds 300

    Set-SyntheticForeground -Handle $syntheticHandle
    $syntheticRect = Get-WindowSnapshot -Handle ($syntheticHandle.ToInt64())
    $coveredHit = Get-PointWindowSnapshot -X $coveredX -Y $coveredY
    if (-not (Test-PointInside -X $coveredX -Y $coveredY -Rect $syntheticRect)) {
        throw 'Covered test point is outside the synthetic foreground window rectangle'
    }
    if (-not (Test-IsNextDeskWindow -Snapshot $coveredHit -ProcessIds $nextDeskPidSet)) {
        throw "Covered test point does not hit NextDesk through the synthetic window hole: $($coveredHit | ConvertTo-Json -Compress)"
    }

    $exposedPoint = $null
    for ($y = $overlay.Top + 12; $y -lt $overlay.Bottom - 12 -and $null -eq $exposedPoint; $y += 12) {
        for ($x = $overlay.Left + 12; $x -lt $overlay.Right - 12; $x += 12) {
            if (Test-PointInside -X $x -Y $y -Rect $syntheticRect) {
                continue
            }
            $hit = Get-PointWindowSnapshot -X $x -Y $y
            if (Test-IsNextDeskWindow -Snapshot $hit -ProcessIds $nextDeskPidSet) {
                $exposedPoint = [pscustomobject]@{ X = $x; Y = $y; Hit = $hit }
                break
            }
        }
    }
    if ($null -eq $exposedPoint) {
        throw 'No exposed NextDesk RDP point was found outside the synthetic foreground window'
    }

    $coveredRows = @()
    for ($iteration = 1; $iteration -le $Iterations; $iteration++) {
        Set-SyntheticForeground -Handle $syntheticHandle
        $before = Get-ForegroundSnapshot
        $hit = Get-PointWindowSnapshot -X $coveredX -Y $coveredY
        [NextDeskFocusNative]::Click($coveredX, $coveredY)
        Start-Sleep -Milliseconds 80
        $afterFast = Get-ForegroundSnapshot
        Start-Sleep -Milliseconds $SettleMilliseconds
        $afterSettled = Get-ForegroundSnapshot

        $row = [ordered]@{
            Scenario = 'covered'
            Iteration = $iteration
            PointX = $coveredX
            PointY = $coveredY
            TriggerHitsNextDesk = Test-IsNextDeskWindow -Snapshot $hit -ProcessIds $nextDeskPidSet
            FocusStolenFast = Test-IsNextDeskWindow -Snapshot $afterFast -ProcessIds $nextDeskPidSet
            FocusStolenSettled = Test-IsNextDeskWindow -Snapshot $afterSettled -ProcessIds $nextDeskPidSet
            ForegroundPreserved = $afterSettled.Handle -eq ($syntheticHandle.ToInt64())
        }
        Add-FlatWindowFields -Row $row -Prefix 'Before' -Snapshot $before
        Add-FlatWindowFields -Row $row -Prefix 'Hit' -Snapshot $hit
        Add-FlatWindowFields -Row $row -Prefix 'AfterFast' -Snapshot $afterFast
        Add-FlatWindowFields -Row $row -Prefix 'AfterSettled' -Snapshot $afterSettled
        $coveredRows += [pscustomobject]$row
    }

    $exposedRows = @()
    for ($iteration = 1; $iteration -le $Iterations; $iteration++) {
        Set-SyntheticForeground -Handle $syntheticHandle
        $before = Get-ForegroundSnapshot
        $hit = Get-PointWindowSnapshot -X $exposedPoint.X -Y $exposedPoint.Y
        [NextDeskFocusNative]::Click($exposedPoint.X, $exposedPoint.Y)
        Start-Sleep -Milliseconds 80
        $afterFast = Get-ForegroundSnapshot
        Start-Sleep -Milliseconds $SettleMilliseconds
        $afterSettled = Get-ForegroundSnapshot

        $row = [ordered]@{
            Scenario = 'exposed'
            Iteration = $iteration
            PointX = $exposedPoint.X
            PointY = $exposedPoint.Y
            TriggerHitsNextDesk = Test-IsNextDeskWindow -Snapshot $hit -ProcessIds $nextDeskPidSet
            ActivatedFast = Test-IsNextDeskWindow -Snapshot $afterFast -ProcessIds $nextDeskPidSet
            ActivatedSettled = Test-IsNextDeskWindow -Snapshot $afterSettled -ProcessIds $nextDeskPidSet
        }
        Add-FlatWindowFields -Row $row -Prefix 'Before' -Snapshot $before
        Add-FlatWindowFields -Row $row -Prefix 'Hit' -Snapshot $hit
        Add-FlatWindowFields -Row $row -Prefix 'AfterFast' -Snapshot $afterFast
        Add-FlatWindowFields -Row $row -Prefix 'AfterSettled' -Snapshot $afterSettled
        $exposedRows += [pscustomobject]$row
    }

    $coveredTriggerCount = @($coveredRows | Where-Object TriggerHitsNextDesk).Count
    $coveredFocusStealCount = @(
        $coveredRows | Where-Object { $_.FocusStolenFast -or $_.FocusStolenSettled }
    ).Count
    $coveredPreservedCount = @($coveredRows | Where-Object ForegroundPreserved).Count
    $exposedTriggerCount = @($exposedRows | Where-Object TriggerHitsNextDesk).Count
    $exposedActivationCount = @(
        $exposedRows | Where-Object { $_.ActivatedFast -or $_.ActivatedSettled }
    ).Count

    $bugReproduced = $coveredTriggerCount -eq $Iterations -and $coveredFocusStealCount -gt 0
    $fixedBehaviorProven =
        $coveredTriggerCount -eq $Iterations -and
        $coveredFocusStealCount -eq 0 -and
        $coveredPreservedCount -eq $Iterations -and
        $exposedTriggerCount -eq $Iterations -and
        $exposedActivationCount -eq $Iterations

    $summary = [ordered]@{
        Timestamp = (Get-Date).ToString('o')
        ComputerName = $env:COMPUTERNAME
        UserName = [Environment]::UserName
        SessionId = (Get-Process -Id $PID).SessionId
        Expectation = $Expectation
        Iterations = $Iterations
        NextDesk = [ordered]@{
            ProcessId = [int]$overlay.ProcessId
            BinaryPath = $binaryPath
            FileVersion = $binaryVersion
            Sha256 = $binarySha256
            OverlayHandle = [long]$overlay.Handle
            OverlayRect = [ordered]@{
                Left = [int]$overlay.Left
                Top = [int]$overlay.Top
                Right = [int]$overlay.Right
                Bottom = [int]$overlay.Bottom
            }
        }
        CoveredScenario = [ordered]@{
            PointX = $coveredX
            PointY = $coveredY
            TriggerCount = $coveredTriggerCount
            FocusStealCount = $coveredFocusStealCount
            ForegroundPreservedCount = $coveredPreservedCount
        }
        ExposedScenario = [ordered]@{
            PointX = [int]$exposedPoint.X
            PointY = [int]$exposedPoint.Y
            TriggerCount = $exposedTriggerCount
            ActivationCount = $exposedActivationCount
        }
        BugReproduced = $bugReproduced
        FixedBehaviorProven = $fixedBehaviorProven
    }

    $coveredRows | Export-Csv -LiteralPath (Join-Path $OutputDirectory 'covered-clicks.csv') -NoTypeInformation -Encoding UTF8
    $exposedRows | Export-Csv -LiteralPath (Join-Path $OutputDirectory 'exposed-clicks.csv') -NoTypeInformation -Encoding UTF8
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'summary.json') -Encoding UTF8
    $summary | ConvertTo-Json -Depth 8

    if ($Expectation -eq 'Broken' -and -not $bugReproduced) {
        $exitCode = 3
    } elseif ($Expectation -eq 'Fixed' -and -not $fixedBehaviorProven) {
        $exitCode = 4
    }
} catch {
    $exitCode = 2
    $errorRecord = [ordered]@{
        Timestamp = (Get-Date).ToString('o')
        Error = $_.Exception.Message
        Detail = ($_ | Out-String)
    }
    $errorRecord | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'error.json') -Encoding UTF8
    Write-Error $_ -ErrorAction Continue
} finally {
    [NextDeskSyntheticForeground]::Stop()
}

exit $exitCode
