#!/bin/bash
export WORKBENCH_CHECKS="plugin_test"
exec /bin/bash "$(dirname "$0")/check.sh"
