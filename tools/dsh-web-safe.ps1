$ErrorActionPreference = 'Stop'
$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path

& node (Join-Path $toolDir 'install-dsh-plugins.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node (Join-Path $toolDir 'ensure-dsh-session-control-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node (Join-Path $toolDir 'apply-dsh-session-format-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node (Join-Path $toolDir 'apply-dsh-permission-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node (Join-Path $toolDir 'apply-dsh-subagent-diagnostic-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node (Join-Path $toolDir 'verify-dsh-permission-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node (Join-Path $toolDir 'apply-dsh-subagent-diagnostic-compat.mjs') --verify
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& dsh web @args
exit $LASTEXITCODE
