#!/usr/bin/env python3
"""Read-only, exact branch-pair lookup across all MR lifecycle states."""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

try:
    repo, source, target, token = sys.argv[1:]
    if not source or not target:
        raise ValueError('missing branch')
    api = os.environ.get('MFC_CODEHUB_API', 'https://codehub-y.example.com/api/v4').rstrip('/')
    base = api + '/projects/' + urllib.parse.quote(urllib.parse.unquote(repo), safe='') + '/merge_requests'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    found = []
    deadline = time.monotonic() + 8
    for page in range(1, 11):
        params = urllib.parse.urlencode(dict(state='all', source_branch=source, target_branch=target, per_page=100, page=page))
        request = urllib.request.Request(base + '?' + params, headers={'Private-Token': token})
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        with opener.open(request, timeout=min(4, remaining)) as response:
            rows = json.load(response)
        if not isinstance(rows, list):
            raise ValueError('invalid list')
        for row in rows:
            if row.get('source_branch') == source and row.get('target_branch') == target:
                if row.get('source_project_id') is not None and row.get('target_project_id') is not None \
                        and row['source_project_id'] != row['target_project_id']:
                    continue  # 同名 fork 分支不是本任务仓的发布。
                if not row.get('iid') or not row.get('web_url'):
                    raise ValueError('missing identity')
                found.append(dict(id=row['iid'], url=row['web_url'], source_branch=source, target_branch=target))
        if len(rows) < 100:
            break
    else:
        raise ValueError('too many results')
    print(json.dumps(dict(mrs=found)))
except Exception as error:
    print('MR 查找失败：' + type(error).__name__, file=sys.stderr)
    sys.exit(1)
