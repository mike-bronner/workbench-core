#!/bin/bash
export WORKBENCH_CHECKS="plugin_json mcp_refs shellcheck bash_syntax frontmatter plugin_root_refs plugin_validate omits_claude_md typescript"
exec /bin/bash "$(dirname "$0")/check.sh"
