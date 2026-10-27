import datetime, fnmatch, os, re, sys

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML is not installed for %s, so the hand-off scan did not "
          "run and the vault was NOT checked. Install it (python3 -m pip install "
          "pyyaml) and run the scan again." % sys.executable, file=sys.stderr)
    raise SystemExit(2)

STALE_DAYS = 14
SKIPPED_SECTIONS = {"related", "logs", "source", "sources"}
FRONTMATTER = re.compile(r"\A\ufeff?---\r?\n(.*?)\r?\n---[ \t]*(\r?\n|\Z)", re.S)
FENCE = re.compile(r"^\s*(```|~~~)")
ITEM = re.compile(r"^\s*([-*+]|\d+[.)])\s+")
TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}")
TAG = re.compile(r"\[\^([^\]\s]+)\]")
args = [a for a in sys.argv[1:] if not a.startswith("--today=")]
VAULT = args[0] if args else os.path.expanduser("~/Documents/Claude/Memory")
TODAY = next((datetime.date.fromisoformat(a.split("=", 1)[1]) for a in sys.argv[1:] if a.startswith("--today=")), datetime.date.today())


def facts(body):
    found, current, fenced, section, lines = [], None, False, "", body.split("\n")
    for at, line in enumerate(lines, 1):
        if FENCE.match(line):
            fenced, current = not fenced, None
            continue
        if fenced:
            continue
        heading = re.match(r"^#{1,6}\s+(.*)", line)
        if heading:
            section, current = heading.group(1).strip().lower(), None
            continue
        if section in SKIPPED_SECTIONS or not line.strip() or line.lstrip().startswith("<!--"):
            current = None
            continue
        if line.lstrip().startswith("|"):
            following = lines[at] if at < len(lines) else ""
            if not TABLE_RULE.match(line) and not TABLE_RULE.match(following):
                found.append([at, line])
            current = None
        elif ITEM.match(line) or current is None:
            current = [at, line]
            found.append(current)
        else:
            current[1] += " " + line.strip()
    return found


findings = 0
for root, dirs, files in os.walk(VAULT):
    dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "cache")
    for fn in sorted(files):
        rel = os.path.relpath(os.path.join(root, fn), VAULT)
        if fn.lower() in ("index.md", "log.md"):
            findings += 1
            print("reserved\t%s" % rel)
            continue
        if not fn.endswith(".md") or fnmatch.fnmatch(rel, "sessions/**/*.log.md"):
            continue
        text = open(os.path.join(root, fn), encoding="utf-8", errors="replace").read()
        match = FRONTMATTER.match(text)
        if not match:
            continue
        try:
            meta = yaml.safe_load(match.group(1)) or {}
        except yaml.YAMLError:
            continue
        if not isinstance(meta, dict):
            continue
        sources = meta.get("sources") if isinstance(meta.get("sources"), list) else []
        ids = {str(s["id"]) for s in sources if isinstance(s, dict) and s.get("id") is not None}
        if not sources and meta.get("type") != "index":
            findings += 1
            print("unsourced\t%s\t%s" % (rel, meta.get("date", "")))
        if len(sources) >= 2:
            offset = text[:match.end()].count("\n")
            for at, fact in facts(text[match.end():]):
                if not any(tag.strip() in ids for tag in TAG.findall(fact)):
                    findings += 1
                    print("untagged\t%s:%d\t%s" % (rel, at + offset, " ".join(fact.split())[:80]))
        if meta.get("type") == "progress":
            updated = meta.get("updated")
            if isinstance(updated, str):
                try:
                    updated = datetime.date.fromisoformat(updated.strip())
                except ValueError:
                    updated = None
            if isinstance(updated, datetime.datetime):
                updated = updated.date()
            if str(meta.get("task_status", "")).strip() == "ended":
                reason = "task ended"
            elif not isinstance(updated, datetime.date):
                reason = "no valid updated date"
            elif (TODAY - updated).days > STALE_DAYS:
                reason = "not updated for %d days" % (TODAY - updated).days
            else:
                continue
            findings += 1
            print("progress\t%s\t%s" % (rel, reason))

raise SystemExit(1 if findings else 0)
