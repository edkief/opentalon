#!/bin/sh
# Ensure persistent tools directories exist on the workspace PVC
mkdir -p \
  /workspace/tools/bin \
  /workspace/tools/lib/python \
  /workspace/tools/lib/node/node_modules \
  /workspace/tools/share

# Wire persistent tools into the environment
export PATH="/workspace/tools/bin:${PATH}"
export PYTHONPATH="/workspace/tools/lib/python:${PYTHONPATH:-}"
export NODE_PATH="/workspace/tools/lib/node/node_modules:${NODE_PATH:-}"

# pip install --target and npm install --prefix destinations
export PIP_TARGET="/workspace/tools/lib/python"
export npm_config_prefix="/workspace/tools/lib/node"

# Suppress .pyc files cluttering the PVC
export PYTHONDONTWRITEBYTECODE=1

# Point git at the workspace-scoped identity files written by the application
# on startup and on every config/secrets hot-reload.
export GIT_CONFIG_GLOBAL="${AGENT_WORKSPACE:-/workspace}/.gitconfig"

exec node server.js
