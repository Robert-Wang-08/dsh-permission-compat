$ErrorActionPreference = 'Stop'
$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path

& node (Join-Path $toolDir 'apply-dsh-permission-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node (Join-Path $toolDir 'verify-dsh-permission-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& dsh web @args
exit $LASTEXITCODE
