#!/bin/bash
# ダブルクリックで JARVIS を起動（Mac 用）
# 作業させたいフォルダを JARVIS_WORKDIR に指定してください（例: ~/Documents/仕事）
cd "$(dirname "$0")"
export JARVIS_WORKDIR="${JARVIS_WORKDIR:-$HOME}"
(sleep 1.5 && open "http://localhost:7777") &
node server.js
