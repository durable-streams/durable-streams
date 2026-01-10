#!/bin/bash
# Wrapper script to run the PHP conformance adapter
cd "$(dirname "$0")"
exec php bin/conformance-adapter
