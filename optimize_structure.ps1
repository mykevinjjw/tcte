# Set encoding to UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "Starting project structure optimization..." -ForegroundColor Cyan

# 1. Create assets directory structure
Write-Host "1. Creating assets directory structure..."
$dirs = @("assets\css", "assets\js", "assets\images")
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
        Write-Host "  Created: $dir" -ForegroundColor Green
    }
}

# 2. Move files
Write-Host "2. Moving files..."

# Move CSS
if (Test-Path "css") {
    Get-ChildItem "css\*" -Recurse | Move-Item -Destination "assets\css" -Force
    Remove-Item "css" -Recurse -Force
    Write-Host "  Moved css to assets\css" -ForegroundColor Green
}

# Move JS
if (Test-Path "js") {
    Get-ChildItem "js\*" -Recurse | Move-Item -Destination "assets\js" -Force
    Remove-Item "js" -Recurse -Force
    Write-Host "  Moved js to assets\js" -ForegroundColor Green
}

# Move ICO (Images)
if (Test-Path "ico") {
    Get-ChildItem "ico\*" -Recurse | Move-Item -Destination "assets\images" -Force
    Remove-Item "ico" -Recurse -Force
    Write-Host "  Moved ico to assets\images" -ForegroundColor Green
}

# 3. Update index.html
Write-Host "3. Updating index.html links..."
$indexPath = "index.html"
if (Test-Path $indexPath) {
    $content = Get-Content $indexPath -Raw -Encoding UTF8
    
    # Replace paths
    $newContent = $content -replace 'href="css/', 'href="assets/css/' `
        -replace 'src="js/', 'src="assets/js/' `
        -replace 'href="ico/', 'href="assets/images/'
    
    if ($content -ne $newContent) {
        $newContent | Set-Content $indexPath -Encoding UTF8
        Write-Host "  index.html updated" -ForegroundColor Green
    }
    else {
        Write-Host "  index.html no changes needed or paths not found" -ForegroundColor Yellow
    }
}
else {
    Write-Host "  Error: index.html not found" -ForegroundColor Red
}

# 4. Add open source documentation
Write-Host "4. Adding open source documentation..."

# LICENSE
$licenseContent = @'
MIT License

Copyright (c) 2025 mykevinjjw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'@
$licenseContent | Set-Content "LICENSE" -Encoding UTF8
Write-Host "  Created LICENSE" -ForegroundColor Green

# CONTRIBUTING.md
$contributingContent = @'
# Contributing Guidelines

Thank you for your interest in contributing to the 2026 TCTE Countdown Webpage!

## How to Contribute
1. Fork this project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## Development Guidelines
- Please keep code clean
- Follow existing directory structure (assets/css, assets/js, etc.)
'@
$contributingContent | Set-Content "CONTRIBUTING.md" -Encoding UTF8
Write-Host "  Created CONTRIBUTING.md" -ForegroundColor Green

# CHANGELOG.md
$changelogContent = @'
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.0.0] - 2025-11-24
### Added
- Initial project structure optimization
- Added LICENSE, CONTRIBUTING.md, and CHANGELOG.md
- Moved static assets to assets/ directory
'@
$changelogContent | Set-Content "CHANGELOG.md" -Encoding UTF8
Write-Host "  Created CHANGELOG.md" -ForegroundColor Green

Write-Host "`nDone! Project structure optimized." -ForegroundColor Cyan
Write-Host "Please manually check index.html to ensure the page displays correctly." -ForegroundColor Yellow
