# Checks what a stranger can reach on a the platform host.
#
# Run it against the live domain, and against a bare IP before you point DNS:
#   .\check-public-exposure.ps1
#   .\check-public-exposure.ps1 -ApiHost 91.92.108.178 -Scheme http
#
# Exit code 1 means something is exposed. Nothing here logs in or sends data;
# it only asks the server what it is willing to hand an anonymous caller.

[CmdletBinding()]
param(
    [string]$ApiHost = 'api.example.com',
    [string]$WebHost = 'example.com',
    [ValidateSet('http', 'https')][string]$Scheme = 'https',
    # Ports that should NOT answer from outside. 269 is ssh and is expected.
    [int[]]$Ports = @(80, 443, 3000, 4000, 5432, 6379, 8080, 9090, 9100)
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$findings = New-Object System.Collections.Generic.List[string]

function Get-Status {
    param([string]$Url)
    try {
        $r = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 12 -MaximumRedirection 0 `
                               -UseBasicParsing -ErrorAction Stop
        return [pscustomobject]@{ Code = [int]$r.StatusCode; Length = $r.RawContentLength }
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($resp) { return [pscustomobject]@{ Code = [int]$resp.StatusCode; Length = -1 } }
        return [pscustomobject]@{ Code = 0; Length = -1 }   # connection/TLS refused
    } catch {
        return [pscustomobject]@{ Code = 0; Length = -1 }
    }
}

Write-Host ""
Write-Host "== API docs surface ($Scheme`://$ApiHost) ==" -ForegroundColor Cyan

# Anything other than 404/403 here means the OpenAPI spec is being served, which
# maps every admin, billing and impersonation route for whoever asks.
$docPaths = @('/docs', '/docs/json', '/docs/chatbot', '/swagger', '/swagger.json',
              '/openapi.json', '/api-docs', '/redoc', '/documentation')
foreach ($p in $docPaths) {
    $s = Get-Status "$Scheme`://$ApiHost$p"
    $open = $s.Code -ge 200 -and $s.Code -lt 400
    $colour = if ($open) { 'Red' } else { 'DarkGray' }
    Write-Host ("  {0,-16} {1}" -f $p, $s.Code) -ForegroundColor $colour
    if ($open) { $findings.Add("API docs reachable: $p returned $($s.Code)") }
}

Write-Host ""
Write-Host "== Unauthenticated endpoints ==" -ForegroundColor Cyan

# /metrics exposes process internals and per-route traffic. It has NO auth in
# the app - the edge is the only thing blocking it, so it must be re-checked
# after every proxy change.
$s = Get-Status "$Scheme`://$ApiHost/metrics"
if ($s.Code -ge 200 -and $s.Code -lt 400) {
    Write-Host "  /metrics         $($s.Code)  EXPOSED" -ForegroundColor Red
    $findings.Add("/metrics is world-readable ($($s.Code)) - the edge deny rule is missing")
} else {
    Write-Host "  /metrics         $($s.Code)  blocked" -ForegroundColor DarkGray
}

# These must answer 401. A 200 is a tenant-data leak.
foreach ($p in @('/api/v1/products', '/api/v1/read/products', '/api/v1/hq/orgs',
                 '/api/v1/contacts', '/api/v1/inbox/threads')) {
    $s = Get-Status "$Scheme`://$ApiHost$p"
    if ($s.Code -eq 200) {
        Write-Host ("  {0,-28} 200  LEAK" -f $p) -ForegroundColor Red
        $findings.Add("$p served data without a token")
    } else {
        Write-Host ("  {0,-28} {1}" -f $p, $s.Code) -ForegroundColor DarkGray
    }
}

# Expected-public. Listed so a change in what they return is visible, not hidden.
foreach ($p in @('/health', '/api/v1/status')) {
    $s = Get-Status "$Scheme`://$ApiHost$p"
    Write-Host ("  {0,-28} {1}  (public by design)" -f $p, $s.Code) -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "== Source and secret files ==" -ForegroundColor Cyan

# example.com is a single-page app with `try_files {path} /index.html`, so EVERY
# path returns 200 and the homepage. Comparing against a random control path
# is what separates a real file from that catch-all - without it this section
# reports .env as exposed on a host that is serving nothing of the sort.
foreach ($h in @($ApiHost, $WebHost)) {
    $control = Get-Status "$Scheme`://$h/zz-control-$(Get-Random)-probe"
    foreach ($p in @('/.env', '/.git/config', '/.git/HEAD', '/config.json')) {
        $s = Get-Status "$Scheme`://$h$p"
        if ($s.Code -lt 200 -or $s.Code -ge 300) { continue }
        if ($control.Code -eq $s.Code -and $control.Length -eq $s.Length) {
            continue   # identical to the catch-all: not a real file
        }
        Write-Host "  $h$p  $($s.Code)  EXPOSED" -ForegroundColor Red
        $findings.Add("$h$p is downloadable ($($s.Length) bytes)")
    }
}
Write-Host "  checked .env / .git / config.json on both hosts (SPA catch-all filtered)" -ForegroundColor DarkGray

Write-Host ""
Write-Host "== Open ports ==" -ForegroundColor Cyan
$target = if ($ApiHost -match '^\d+\.\d+\.\d+\.\d+$') { $ApiHost } else {
    (Resolve-DnsName $ApiHost -Type A -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
}
if (-not $target) {
    Write-Host "  could not resolve $ApiHost - skipping port scan" -ForegroundColor Yellow
} else {
    Write-Host "  target $target" -ForegroundColor DarkGray
    foreach ($port in $Ports) {
        $c = New-Object Net.Sockets.TcpClient
        $ok = $false
        try { $ok = $c.ConnectAsync($target, $port).Wait(3000) } catch { $ok = $false }
        finally { $c.Close() }
        if ($ok) {
            $expected = $port -in @(80, 443)
            if ($expected) {
                Write-Host "  $port open (expected)" -ForegroundColor DarkGray
            } else {
                Write-Host "  $port OPEN - should not be reachable" -ForegroundColor Red
                $findings.Add("port $port is open to the internet on $target")
            }
        }
    }
}

Write-Host ""
if ($findings.Count -eq 0) {
    Write-Host "No exposure found on $ApiHost." -ForegroundColor Green
    Write-Host "This covers the paths listed above only - it is not proof of a clean host." -ForegroundColor DarkGray
    exit 0
}
Write-Host "$($findings.Count) problem(s):" -ForegroundColor Red
$findings | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
exit 1
