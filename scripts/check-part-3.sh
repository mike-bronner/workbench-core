#!/bin/bash
export WORKBENCH_CHECKS="hook_suites_even"
exec /bin/bash "$(dirname "$0")/check.sh"
