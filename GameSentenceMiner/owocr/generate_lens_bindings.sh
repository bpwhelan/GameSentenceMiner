#!/usr/bin/env bash

if [ -z "$1" ]; then
    echo "Usage: $0 <path_to_proto_files>"
    exit 1
fi

PROTO_PATH="$1"

mkdir tmp
protoc "--proto_path=$PROTO_PATH" --python_betterproto_out=tmp $PROTO_PATH/*.proto
mv tmp/lens/__init__.py owocr/lens_betterproto.py
rm -rf tmp