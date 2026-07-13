#!/bin/bash

set -e

MODE="${1}"
shift || true

# Default registry and image name
REGISTRY="${REGISTRY:-registry.kieffer.me}"
IMAGE_NAME="${IMAGE_NAME:-$(basename -s .git "$(git remote get-url origin 2>/dev/null || git rev-parse --show-toplevel)")}"

echo "Registry: ${REGISTRY}"
echo "Image:    ${IMAGE_NAME}"
echo "Mode:     ${MODE}"

if [ -n "$(git status --porcelain)" ]; then
  DIRTY=1
else
  DIRTY=0
fi

if [ "$MODE" = "hash" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD | sed -e 's/[^A-Za-z0-9_.-]/-/g' -e 's/^[.-]*//')
  HASH=$(git rev-parse --short HEAD)
  BASE_TAG="${BRANCH}-${HASH}"
elif [ "$MODE" = "ts" ]; then
  HASH=$(git rev-parse --short HEAD)
  BASE_TAG="build-${HASH}-$(date +%Y%m%d-%H%M)"
else
  echo "Usage: $0 [hash|ts] [docker build args...]"
  exit 1
fi

echo "Base tag: ${BASE_TAG}"

if [ "$MODE" = "hash" ]; then
  if [ "$DIRTY" -eq 1 ]; then
    echo "Refusing to build with mode 'hash' on a dirty tree. Commit or stash your changes first."
    git status --porcelain
    exit 1
  fi
  TAG="$BASE_TAG"
elif [ "$MODE" = "ts" ]; then
  DIRTY_SUFFIX=""
  if [ "$DIRTY" -eq 1 ]; then
    echo "Working tree is dirty."
    git status --porcelain
    read -r -p "Push a dirty image? [y/N] " CONFIRM
    case "$CONFIRM" in
      [yY]|[yY][eE][sS])
        DIRTY_SUFFIX="-dirty"
        ;;
      *)
        echo "Aborting."
        exit 1
        ;;
    esac
  fi
  TAG="${BASE_TAG}${DIRTY_SUFFIX}"
fi

if [ "${#TAG}" -gt 128 ]; then
  echo "Tag exceeds 128 characters (OCI image tag limit): ${TAG} (${#TAG} chars)"
  exit 1
fi

IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"

echo "Building and pushing $IMAGE"

docker build -t "$IMAGE" "$@" . && \
    docker push "$IMAGE" && \
    echo "Done! Image pushed as $IMAGE"
