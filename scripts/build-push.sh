#!/bin/bash

set -e

TAG=$(date +%y%m%d-%H%M)
IMAGE="registry.kieffer.me/opentalon:manual-${TAG}"

echo "Building and pushing $IMAGE"

docker build -t "$IMAGE" $* . && \
    docker push "$IMAGE" && \
    echo "Done! Image pushed as $IMAGE"
