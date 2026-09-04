#!/usr/bin/env bash

set -euo pipefail

root_path=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dist_path="${root_path}/dist"
bin_path="${root_path}/bin"
temp_path="${root_path}/temp"

cleanup() {
  rm -rf "${temp_path}"
}
trap cleanup EXIT

rm -rf "${dist_path}"
mkdir -p "${dist_path}"

"${root_path}/node_modules/.bin/tsc" --outDir "${dist_path}"

# 生成版本号和图标
node "${bin_path}/build-version.js" "${root_path}"
node "${bin_path}/build-icon.js" "${root_path}"

cp -R "${root_path}/public/." "${dist_path}/"

# 生成 stylus -> css 的文件到 dist 文件夹中
node "${bin_path}/build-css.js" "${root_path}"

# uTools 要求 preload 的第三方 Node.js 依赖与源码一同放在产物中。
mkdir -p "${temp_path}"
node "${bin_path}/build-dependencies.js" "${root_path}" "${temp_path}"
(
  cd "${temp_path}"
  npm install --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund
)

node "${bin_path}/build-clean.js" "${root_path}"

rm -f "${temp_path}/node_modules/winreg/lib/registry.js"
cp "${root_path}/lib/winreg/lib/registry.js" "${temp_path}/node_modules/winreg/lib/registry.js"

cp -R "${temp_path}/node_modules" "${dist_path}/"
